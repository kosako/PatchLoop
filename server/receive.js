"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = process.env.PATCHLOOP_RECEIVER_CONFIG || path.join(__dirname, "receiver.config.json");
const config = loadConfig(CONFIG_PATH);
const configDir = path.dirname(CONFIG_PATH);

const PORT = Number(process.env.PORT || config.port || 4000);
const HOST = process.env.HOST || config.host || "127.0.0.1";
const STORE_PATH = process.env.FEEDBACK_STORE_PATH || pathFromConfig(config.feedbackStorePath, path.join(__dirname, "feedback.json"));
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || config.maxBodyBytes || 3_000_000);
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || pathFromConfig(config.screenshotDir, path.join(__dirname, "screenshots"));
const SCREENSHOT_MAX_BYTES = Number(process.env.SCREENSHOT_MAX_BYTES || config.screenshotMaxBytes || 1_500_000);
const PUBLIC_BASE_URL = trimTrailingSlash(process.env.PUBLIC_BASE_URL || config.publicBaseUrl || `http://${HOST}:${PORT}`);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || config.slackWebhookUrl || "";
const SLACK_TIMEOUT_MS = Number(process.env.SLACK_TIMEOUT_MS || config.slackTimeoutMs || 5000);
const SLACK_IMAGE_MODE = normalizeSlackImageMode(process.env.SLACK_IMAGE_MODE || config.slackImageMode || "auto");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || config.slackBotToken || "";
const SLACK_UPLOAD_CHANNEL_ID = process.env.SLACK_UPLOAD_CHANNEL_ID || config.slackUploadChannelId || "";
const IMPORT_BUNDLE_KIND = "patchloop-feedback-bundle";
const IMPORT_BUNDLE_VERSION = 1;
const FEEDBACK_STATUSES = ["new", "accepted", "fixed", "ignored"];

let feedback = loadFeedback();

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/feedback") {
    handlePostFeedback(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/import") {
    handlePostImport(req, res);
    return;
  }

  const statusMatch = req.method === "POST" && /^\/feedback\/([^/]+)\/status$/.exec(req.url);
  if (statusMatch) {
    handlePostStatus(req, res, decodeURIComponent(statusMatch[1]));
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    handleGetInbox(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/feedback.json") {
    respondJson(res, 200, feedback);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/screenshots/")) {
    handleGetScreenshot(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`[PatchLoop receiver] listening on http://${HOST}:${PORT}`);
  console.log(`[PatchLoop receiver] config file: ${config.__loaded ? CONFIG_PATH : "not loaded"}`);
  console.log(`[PatchLoop receiver] feedback file: ${STORE_PATH}`);
  console.log(`[PatchLoop receiver] screenshot dir: ${SCREENSHOT_DIR}`);
  console.log(`[PatchLoop receiver] Slack webhook: ${SLACK_WEBHOOK_URL ? "enabled" : "disabled"}`);
  console.log(`[PatchLoop receiver] Slack image mode: ${SLACK_IMAGE_MODE}`);
  console.log(`[PatchLoop receiver] Slack file upload: ${SLACK_BOT_TOKEN && SLACK_UPLOAD_CHANNEL_ID ? "enabled" : "disabled"}`);
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function loadConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? { ...parsed, __loaded: true }
      : {};
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[PatchLoop receiver] config file ignored: ${error.message}`);
    }
    return {};
  }
}

function pathFromConfig(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeSlackImageMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (["auto", "link", "block", "upload", "off"].includes(mode)) return mode;
  return "auto";
}

function handlePostFeedback(req, res) {
  readJsonBody(req, res, async (payload) => {
    let screenshot;
    try {
      validateFeedbackPayload(payload);
      screenshot = saveScreenshot(payload.screenshot, payload.id);
    } catch (error) {
      respondJson(res, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    const stored = { receivedAt: new Date().toISOString(), ...payload, screenshot };
    stored.integrations = {
      ...(stored.integrations || {}),
      slack: await deliverToSlack(stored)
    };
    feedback.unshift(stored);
    persist();
    const slackLog = stored.integrations.slack.status === "disabled"
      ? ""
      : ` slack=${stored.integrations.slack.status}`;
    console.log(`[PatchLoop receiver] received feedback id=${payload?.id || "?"} comment="${truncate(payload?.comment || "", 60)}"${slackLog}`);
    respondJson(res, 201, {
      ok: true,
      id: payload?.id,
      count: feedback.length,
      slack: stored.integrations.slack
    });
  });
}

function handlePostImport(req, res) {
  readJsonBody(req, res, async (body) => {
    let imported;
    let screenshot;
    try {
      imported = normalizeImportedBundle(body);
      screenshot = saveScreenshot(imported.screenshot, imported.id);
    } catch (error) {
      respondJson(res, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    const now = new Date().toISOString();
    const stored = {
      ...imported,
      receivedAt: now,
      importedAt: now,
      source: "import",
      screenshot,
      integrations: {
        slack: { status: "skipped", reason: "import" }
      }
    };

    feedback.unshift(stored);
    persist();
    console.log(`[PatchLoop receiver] imported feedback id=${stored.id || "?"} comment="${truncate(stored.comment || "", 60)}"`);
    respondJson(res, 201, {
      ok: true,
      id: stored.id,
      count: feedback.length,
      source: "import"
    });
  });
}

function handlePostStatus(req, res, id) {
  readJsonBody(req, res, async (body) => {
    const status = body && body.status;
    if (!FEEDBACK_STATUSES.includes(status)) {
      respondJson(res, 400, { ok: false, error: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}` });
      return;
    }

    const item = feedback.find((entry) => entry.id === id);
    if (!item) {
      respondJson(res, 404, { ok: false, error: `Unknown feedback id: ${id}` });
      return;
    }

    item.status = status;
    item.statusUpdatedAt = new Date().toISOString();
    persist();
    respondJson(res, 200, { ok: true, id, status });
  });
}

function readJsonBody(req, res, onJson) {
  let received = 0;
  const chunks = [];
  let aborted = false;

  req.on("data", (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      aborted = true;
      respondJson(res, 413, { ok: false, error: "Payload too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (_) {
      respondJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    try {
      await onJson(payload);
    } catch (error) {
      if (!res.headersSent) {
        respondJson(res, error.statusCode || 500, { ok: false, error: error.message });
      }
    }
  });

  req.on("error", (error) => {
    if (aborted) return;
    respondJson(res, 500, { ok: false, error: error.message });
  });
}

function normalizeImportedBundle(body) {
  requirePlainObject(body, "Import body");

  let payload;
  if (body.kind === IMPORT_BUNDLE_KIND) {
    if (body.version !== IMPORT_BUNDLE_VERSION) {
      throw httpError(`Unsupported PatchLoop bundle version: ${body.version}`, 400);
    }
    payload = body.feedback;
  } else if (body.feedback) {
    payload = body.feedback;
  } else {
    payload = body;
  }

  validateFeedbackPayload(payload);
  const imported = JSON.parse(JSON.stringify(payload));
  delete imported.delivery;
  delete imported.integrations;
  delete imported.receivedAt;
  delete imported.importedAt;
  delete imported.source;
  return imported;
}

function validateFeedbackPayload(payload) {
  requirePlainObject(payload, "Feedback payload");
  requireNonEmptyString(payload.id, "feedback.id");
  requireNonEmptyString(payload.comment, "feedback.comment");
  requireNonEmptyString(payload.reviewer, "feedback.reviewer");
  requirePlainObject(payload.page, "feedback.page");
  requirePlainObject(payload.target, "feedback.target");
  requirePlainObject(payload.environment, "feedback.environment");

  if (payload.projectId != null) requireString(payload.projectId, "feedback.projectId");
  if (payload.demoId != null) requireString(payload.demoId, "feedback.demoId");
  if (payload.createdAt != null) requireString(payload.createdAt, "feedback.createdAt");
  if (payload.page.url != null) requireString(payload.page.url, "feedback.page.url");
  if (payload.page.title != null) requireString(payload.page.title, "feedback.page.title");

  if (!["point", "area"].includes(payload.target.kind)) {
    throw httpError("feedback.target.kind must be point or area", 400);
  }
  if (payload.target.selector != null) requireString(payload.target.selector, "feedback.target.selector");
  if (payload.target.text != null) requireString(payload.target.text, "feedback.target.text");
  if (payload.target.area != null) requirePlainObject(payload.target.area, "feedback.target.area");
  if (payload.screenshot != null) requirePlainObject(payload.screenshot, "feedback.screenshot");
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(`${label} must be an object`, 400);
  }
}

function requireString(value, label) {
  if (typeof value !== "string") {
    throw httpError(`${label} must be a string`, 400);
  }
}

function requireNonEmptyString(value, label) {
  requireString(value, label);
  if (!value.trim()) {
    throw httpError(`${label} must not be empty`, 400);
  }
}

function handleGetInbox(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderInbox(feedback));
}

function handleGetScreenshot(req, res) {
  let filename;
  try {
    const url = new URL(req.url, "http://localhost");
    filename = path.basename(decodeURIComponent(url.pathname));
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid screenshot path");
    return;
  }

  const screenshotPath = path.resolve(SCREENSHOT_DIR, filename);
  const screenshotRoot = path.resolve(SCREENSHOT_DIR);
  if (!screenshotPath.startsWith(`${screenshotRoot}${path.sep}`)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  fs.readFile(screenshotPath, (error, buffer) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeForPath(screenshotPath),
      "Cache-Control": "no-store"
    });
    res.end(buffer);
  });
}

function loadFeedback() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function persist() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(feedback, null, 2));
}

function saveScreenshot(screenshot, id) {
  if (!screenshot) return null;

  const metadata = { ...screenshot };
  delete metadata.dataUrl;

  if (screenshot.status && screenshot.status !== "captured") {
    return metadata;
  }

  if (!screenshot.dataUrl) {
    return { ...metadata, status: "missing" };
  }

  const parsed = parseDataUrl(screenshot.dataUrl);
  const extension = extensionForMimeType(parsed.mimeType);
  if (!extension) {
    throw httpError(`Unsupported screenshot mime type: ${parsed.mimeType}`, 400);
  }

  if (parsed.buffer.length > SCREENSHOT_MAX_BYTES) {
    throw httpError(`Screenshot too large: ${parsed.buffer.length} bytes exceeds ${SCREENSHOT_MAX_BYTES}`, 413);
  }

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const fileName = `${safeFilePart(id || "feedback")}-${Date.now()}.${extension}`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  fs.writeFileSync(filePath, parsed.buffer);

  return {
    ...metadata,
    status: "saved",
    mimeType: parsed.mimeType,
    fileName,
    path: filePath,
    url: `${PUBLIC_BASE_URL}/screenshots/${encodeURIComponent(fileName)}`,
    bytes: parsed.buffer.length
  };
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) {
    throw httpError("Invalid screenshot data URL", 400);
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "";
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function safeFilePart(value) {
  return String(value || "feedback")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "feedback";
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function respondJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function deliverToSlack(item) {
  if (!SLACK_WEBHOOK_URL) {
    const image = await maybeUploadScreenshotToSlack(item);
    if (image.status === "uploaded") {
      return { status: "sent", image };
    }
    if (image.status === "disabled") {
      return { status: "disabled" };
    }
    return { status: "failed", image, error: image.error || image.reason || "Slack webhook is disabled" };
  }

  try {
    const response = await postJson(SLACK_WEBHOOK_URL, buildSlackMessage(item));
    const result = response.statusCode >= 200 && response.statusCode < 300
      ? { status: "sent", statusCode: response.statusCode }
      : {
          status: "failed",
          statusCode: response.statusCode,
          error: truncate(response.body || "Slack webhook returned a non-2xx response", 240)
        };

    if (response.statusCode >= 200 && response.statusCode < 300) {
      const image = await maybeUploadScreenshotToSlack(item);
      if (image.status !== "disabled" && image.status !== "skipped") {
        result.image = image;
      }
    }
    return result;
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

function postJson(targetUrl, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (error) {
      reject(new Error(`Invalid SLACK_WEBHOOK_URL: ${error.message}`));
      return;
    }

    const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!client) {
      reject(new Error(`Unsupported webhook protocol: ${url.protocol}`));
      return;
    }

    const json = JSON.stringify(body);
    const request = client.request(url, {
      method: "POST",
      timeout: SLACK_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
        "User-Agent": "PatchLoop receiver"
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode || 0, body: raw });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Slack webhook timed out after ${SLACK_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    request.write(json);
    request.end();
  });
}

async function maybeUploadScreenshotToSlack(item) {
  if (SLACK_IMAGE_MODE !== "auto" && SLACK_IMAGE_MODE !== "upload") {
    return { status: "disabled" };
  }

  if (!SLACK_BOT_TOKEN || !SLACK_UPLOAD_CHANNEL_ID) {
    return { status: "disabled" };
  }

  const screenshot = item.screenshot;
  if (!screenshot || screenshot.status !== "saved" || !screenshot.path) {
    return { status: "skipped", reason: "no saved screenshot" };
  }

  let buffer;
  try {
    buffer = await fs.promises.readFile(screenshot.path);
  } catch (error) {
    return { status: "failed", error: `Unable to read screenshot: ${error.message}` };
  }

  const filename = screenshot.fileName || path.basename(screenshot.path);
  const title = `PatchLoop screenshot ${item.id || ""}`.trim();

  try {
    const uploadInit = await postSlackApi("files.getUploadURLExternal", {
      filename,
      length: buffer.length,
      alt_txt: "PatchLoop viewport snapshot"
    });

    if (!uploadInit.ok || !uploadInit.upload_url || !uploadInit.file_id) {
      return {
        status: "failed",
        error: uploadInit.error || "files.getUploadURLExternal failed"
      };
    }

    const uploadResponse = await uploadBinary(uploadInit.upload_url, buffer, screenshot.mimeType || contentTypeForPath(filename));
    if (uploadResponse.statusCode < 200 || uploadResponse.statusCode >= 300) {
      return {
        status: "failed",
        statusCode: uploadResponse.statusCode,
        error: truncate(uploadResponse.body || "upload_url returned a non-2xx response", 240)
      };
    }

    const completed = await postSlackApi("files.completeUploadExternal", {
      channel_id: SLACK_UPLOAD_CHANNEL_ID,
      files: [
        {
          id: uploadInit.file_id,
          title
        }
      ]
    });

    if (!completed.ok) {
      return {
        status: "failed",
        fileId: uploadInit.file_id,
        error: completed.error || "files.completeUploadExternal failed"
      };
    }

    return {
      status: "uploaded",
      fileId: uploadInit.file_id,
      channelId: SLACK_UPLOAD_CHANNEL_ID
    };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

function postSlackApi(method, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const request = https.request(`https://slack.com/api/${method}`, {
      method: "POST",
      timeout: SLACK_TIMEOUT_MS,
      headers: {
        "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(json),
        "User-Agent": "PatchLoop receiver"
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Slack API returned invalid JSON: ${error.message}`));
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Slack API timed out after ${SLACK_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    request.write(json);
    request.end();
  });
}

function uploadBinary(targetUrl, buffer, mimeType) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (error) {
      reject(new Error(`Invalid Slack upload URL: ${error.message}`));
      return;
    }

    const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!client) {
      reject(new Error(`Unsupported upload protocol: ${url.protocol}`));
      return;
    }

    const request = client.request(url, {
      method: "POST",
      timeout: SLACK_TIMEOUT_MS,
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Length": buffer.length,
        "User-Agent": "PatchLoop receiver"
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode || 0, body: raw });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Slack upload timed out after ${SLACK_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    request.write(buffer);
    request.end();
  });
}

function buildSlackMessage(item) {
  const target = item.target || {};
  const env = item.environment || {};
  const page = item.page || {};
  const comment = slackEscape(truncate(item.comment || "(empty comment)", 1400));
  const screenshotUrl = screenshotUrlFor(item.screenshot);
  const pageText = page.url
    ? formatSlackLink(page.url, page.title || page.url)
    : slackEscape(page.title || "(unknown page)");
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "PatchLoop feedback",
        emoji: false
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: comment
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Reviewer*\n${slackEscape(item.reviewer || "(no name)")}` },
        { type: "mrkdwn", text: `*Page*\n${pageText}` },
        { type: "mrkdwn", text: `*Target*\n${slackEscape(formatTarget(target))}` },
        { type: "mrkdwn", text: `*Viewport*\n${slackEscape(formatViewport(env.viewport))}` },
        { type: "mrkdwn", text: `*Selector*\n${formatSlackCode(target.selector || "(none)")}` },
        { type: "mrkdwn", text: `*Created*\n${slackEscape(item.createdAt || item.receivedAt || "(unknown)")}` }
      ]
    }
  ];

  if (target.text) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Element text*\n>${slackEscape(truncate(target.text, 500)).replaceAll("\n", "\n>")}`
      }
    });
  }

  if (screenshotUrl) {
    if (SLACK_IMAGE_MODE !== "off") {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Screenshot*\n${formatSlackLink(screenshotUrl, "Open viewport snapshot")}`
        }
      });
    }
    if (shouldSendSlackImageBlock(screenshotUrl)) {
      blocks.push({
        type: "image",
        image_url: screenshotUrl,
        alt_text: "PatchLoop viewport snapshot"
      });
    }
  } else if (item.screenshot && item.screenshot.status) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `screenshot: ${formatSlackCode(formatScreenshotStatus(item.screenshot))}`
        }
      ]
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `project: ${formatSlackCode(item.projectId || "-")} · demo: ${formatSlackCode(item.demoId || "-")} · id: ${formatSlackCode(item.id || "-")}`
      }
    ]
  });

  return {
    text: `PatchLoop feedback: ${truncate(item.comment || "", 120)}`,
    blocks
  };
}

function slackEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatSlackCode(value) {
  return `\`${slackEscape(truncate(String(value ?? "").replaceAll("`", "'"), 180))}\``;
}

function formatSlackLink(url, label) {
  if (!/^https?:\/\//.test(url)) {
    return slackEscape(url);
  }
  return `<${slackEscape(url)}|${slackEscape(truncate(String(label).replaceAll("|", "/"), 120))}>`;
}

function screenshotUrlFor(screenshot) {
  if (!screenshot || screenshot.status !== "saved" || !screenshot.url) return "";
  return screenshot.url;
}

function formatScreenshotStatus(screenshot) {
  if (!screenshot) return "none";
  if (screenshot.status === "omitted" && screenshot.reason === "too-large") {
    return `omitted: ${present(screenshot.bytes)} bytes exceeds ${present(screenshot.maxBytes)}`;
  }
  if (screenshot.status === "saved") {
    return `saved (${present(screenshot.bytes)} bytes)`;
  }
  return screenshot.status || "unknown";
}

function isLikelyPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "0.0.0.0" || host === "::1") return false;
    if (host.startsWith("127.")) return false;
    if (host.startsWith("10.")) return false;
    if (host.startsWith("192.168.")) return false;
    const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    return !private172;
  } catch (_) {
    return false;
  }
}

function shouldSendSlackImageBlock(screenshotUrl) {
  if (!screenshotUrl || SLACK_IMAGE_MODE === "off" || SLACK_IMAGE_MODE === "link" || SLACK_IMAGE_MODE === "upload") {
    return false;
  }
  if (SLACK_IMAGE_MODE === "block") return /^https?:\/\//.test(screenshotUrl);
  return isLikelyPublicHttpUrl(screenshotUrl);
}

function formatViewport(viewport) {
  if (!viewport) return "(unknown)";
  return `${present(viewport.width)}x${present(viewport.height)}`;
}

function formatTarget(target) {
  if (target.kind === "area" && target.area) {
    return `area ${present(target.area.clientWidth)}x${present(target.area.clientHeight)} at ${present(target.area.clientX)},${present(target.area.clientY)}`;
  }
  return `${target.kind || "point"} at ${present(target.clientX)},${present(target.clientY)}`;
}

function present(value) {
  return value === undefined || value === null || value === "" ? "?" : value;
}

function feedbackStatusOf(item) {
  return FEEDBACK_STATUSES.includes(item.status) ? item.status : "new";
}

function renderInbox(items) {
  const cards = items.map((item) => {
    const target = item.target || {};
    const env = item.environment || {};
    const page = item.page || {};
    const slack = item.integrations && item.integrations.slack;
    const screenshot = item.screenshot;
    const kind = escapeHtml(target.kind || "?");
    const selector = escapeHtml(target.selector || "");
    const pageUrl = escapeHtml(page.url || "");
    const pageTitle = escapeHtml(page.title || "");
    const comment = escapeHtml(item.comment || "");
    const reviewer = escapeHtml(item.reviewer || "");
    const createdAt = escapeHtml(item.createdAt || "");
    const receivedAt = escapeHtml(item.receivedAt || "");
    const source = escapeHtml(item.source || "receiver");
    const importedAt = escapeHtml(item.importedAt || "");
    const status = feedbackStatusOf(item);
    const slackStatus = escapeHtml((slack && slack.status) || "unknown");
    const searchText = escapeHtml([item.comment, item.reviewer, target.selector, page.url, page.title, item.id]
      .filter(Boolean).join(" ").toLowerCase());
    const statusOptions = FEEDBACK_STATUSES
      .map((value) => `<option value="${value}"${value === status ? " selected" : ""}>${value}</option>`)
      .join("");
    const viewport = env.viewport
      ? `${env.viewport.width}×${env.viewport.height}`
      : "";
    return `
      <article class="card" data-card data-status="${status}" data-kind="${kind}" data-reviewer="${reviewer}" data-source="${source}" data-slack="${slackStatus}" data-search="${searchText}">
        <header>
          <span class="kind kind-${kind}">${kind}</span>
          <span class="reviewer">${reviewer || "(no name)"}</span>
          <label class="status-control">
            <select data-status-select data-feedback-id="${escapeHtml(item.id || "")}">${statusOptions}</select>
          </label>
          <time>${receivedAt}</time>
        </header>
        <p class="comment">${comment}</p>
        ${renderScreenshotPreview(screenshot)}
        <dl>
          <div><dt>URL</dt><dd><a href="${pageUrl}" target="_blank" rel="noopener">${pageUrl}</a></dd></div>
          <div><dt>Title</dt><dd>${pageTitle}</dd></div>
          <div><dt>Selector</dt><dd><code>${selector}</code></dd></div>
          <div><dt>Viewport</dt><dd>${escapeHtml(viewport)}</dd></div>
          <div><dt>Source</dt><dd>${source}</dd></div>
          <div><dt>Slack</dt><dd>${escapeHtml(formatSlackStatus(slack))}</dd></div>
          <div><dt>Created</dt><dd>${createdAt}</dd></div>
          ${importedAt ? `<div><dt>Imported</dt><dd>${importedAt}</dd></div>` : ""}
        </dl>
        <details>
          <summary>raw payload</summary>
          <pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
        </details>
      </article>
    `;
  });

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PatchLoop Inbox</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #14211d; }
    body { margin: 0; padding: 24px; background: #f7f8f5; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    .meta { color: #65716d; margin-bottom: 24px; font-size: 13px; }
    .meta a { color: #0f7b63; }
    .empty { color: #65716d; }
    .import-panel { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin: 0 0 18px; padding: 14px 16px; border: 1px solid #d9e1dd; border-radius: 8px; background: #fff; }
    .import-panel h2 { margin: 0; font-size: 15px; }
    .import-panel p { margin: 4px 0 0; color: #65716d; font-size: 12px; }
    .import-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .import-form input { max-width: min(360px, 100%); }
    .import-form button { min-height: 34px; border: 1px solid #0f7b63; border-radius: 6px; background: #0f7b63; color: #fff; padding: 0 12px; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; }
    .import-status { min-width: 160px; color: #65716d; font-size: 12px; }
    .import-status[data-state="error"] { color: #b83d4d; font-weight: 800; }
    .filter-panel { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 18px; padding: 12px 16px; border: 1px solid #d9e1dd; border-radius: 8px; background: #fff; }
    .filter-panel input[type="search"] { flex: 1; min-width: 220px; min-height: 32px; border: 1px solid #d9e1dd; border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 13px; }
    .filter-panel select { min-height: 32px; border: 1px solid #d9e1dd; border-radius: 6px; background: #fff; padding: 4px 6px; font: inherit; font-size: 12px; color: #14211d; }
    .filter-count { color: #65716d; font-size: 12px; min-width: 70px; text-align: right; margin-left: auto; }
    .card { background: #fff; border: 1px solid #d9e1dd; border-left: 4px solid #8a9590; border-radius: 8px; padding: 16px 18px; margin-bottom: 14px; box-shadow: 0 4px 12px rgba(20, 33, 29, 0.05); }
    .card[data-status="new"] { border-left-color: #8a9590; }
    .card[data-status="accepted"] { border-left-color: #0f7b63; }
    .card[data-status="fixed"] { border-left-color: #2c6fb0; }
    .card[data-status="ignored"] { border-left-color: #c2c9c5; opacity: 0.72; }
    .card header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; color: #65716d; }
    .status-control select { min-height: 26px; border: 1px solid #d9e1dd; border-radius: 999px; background: #f7f8f5; padding: 2px 8px; font: inherit; font-size: 11px; font-weight: 800; color: #14211d; cursor: pointer; }
    .kind { padding: 2px 8px; border-radius: 999px; font-weight: 800; color: #fff; font-size: 11px; text-transform: uppercase; }
    .kind-point { background: #0f7b63; }
    .kind-area { background: #d1495b; }
    .reviewer { font-weight: 700; color: #14211d; }
    time { margin-left: auto; }
    .comment { font-size: 15px; margin: 0 0 12px; white-space: pre-wrap; }
    .screenshot { margin: 0 0 12px; border: 1px solid #d9e1dd; border-radius: 8px; overflow: hidden; background: #f7f8f5; }
    .screenshot a { display: block; }
    .screenshot img { display: block; width: 100%; max-height: 360px; object-fit: contain; background: #fff; }
    .screenshot figcaption, .screenshot-note { margin: 0 0 12px; color: #65716d; font-size: 12px; }
    .screenshot figcaption { padding: 8px 10px; border-top: 1px solid #d9e1dd; margin: 0; }
    dl { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; margin: 0; font-size: 13px; }
    dl > div { display: contents; }
    dt { color: #65716d; }
    dd { margin: 0; word-break: break-all; }
    dd a { color: #0f7b63; }
    code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f7f8f5; padding: 1px 4px; border-radius: 4px; }
    details { margin-top: 10px; }
    summary { cursor: pointer; font-size: 12px; color: #65716d; }
    pre { background: #14211d; color: #c8d4cf; padding: 12px; border-radius: 6px; overflow-x: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <h1>PatchLoop Inbox</h1>
  <p class="meta">${items.length} feedback received · <a href="/feedback.json">raw JSON</a></p>
  ${renderImportPanel()}
  ${items.length === 0 ? "" : renderFilterPanel(items)}
  ${items.length === 0 ? '<p class="empty">まだフィードバックはありません。widget からコメントを送ると、ここに表示されます。</p>' : cards.join("")}
  <p class="empty" data-filter-empty hidden>絞り込みに一致する feedback はありません。</p>
  ${renderImportScript()}
  ${renderTriageScript()}
</body>
</html>`;
}

function renderImportPanel() {
  return `
  <section class="import-panel">
    <div>
      <h2>Import feedback bundle</h2>
      <p>Download mode で保存した .patchloop-feedback.json を読み込みます。</p>
    </div>
    <form class="import-form" data-import-form>
      <input type="file" accept=".json,application/json" data-import-file />
      <button type="submit">Import</button>
      <span class="import-status" data-import-status></span>
    </form>
  </section>`;
}

function renderFilterPanel(items) {
  const optionList = (values, allLabel) => [`<option value="">${allLabel}</option>`]
    .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
    .join("");
  const unique = (mapper) => Array.from(new Set(items.map(mapper).filter(Boolean))).sort();
  const reviewers = unique((item) => item.reviewer || "");
  const sources = unique((item) => item.source || "receiver");
  const slackStatuses = unique((item) => (item.integrations && item.integrations.slack && item.integrations.slack.status) || "unknown");

  return `
  <section class="filter-panel" data-filter-panel>
    <input type="search" placeholder="検索（コメント / reviewer / selector / URL）" data-filter-text />
    <select data-filter-key="status">${optionList(FEEDBACK_STATUSES, "Status: all")}</select>
    <select data-filter-key="kind">${optionList(["point", "area"], "Kind: all")}</select>
    <select data-filter-key="reviewer">${optionList(reviewers, "Reviewer: all")}</select>
    <select data-filter-key="source">${optionList(sources, "Source: all")}</select>
    <select data-filter-key="slack">${optionList(slackStatuses, "Slack: all")}</select>
    <span class="filter-count" data-filter-count></span>
  </section>`;
}

function renderTriageScript() {
  return `<script>
(() => {
  const cards = Array.from(document.querySelectorAll("[data-card]"));

  const panel = document.querySelector("[data-filter-panel]");
  if (panel) {
    const textInput = panel.querySelector("[data-filter-text]");
    const selects = Array.from(panel.querySelectorAll("[data-filter-key]"));
    const count = panel.querySelector("[data-filter-count]");
    const emptyNote = document.querySelector("[data-filter-empty]");

    const applyFilters = () => {
      const text = textInput.value.trim().toLowerCase();
      let visible = 0;
      cards.forEach((card) => {
        const matchesText = !text || card.dataset.search.includes(text);
        const matchesSelects = selects.every((select) => !select.value || card.dataset[select.dataset.filterKey] === select.value);
        const show = matchesText && matchesSelects;
        card.hidden = !show;
        if (show) visible += 1;
      });
      count.textContent = visible === cards.length ? cards.length + " 件" : visible + " / " + cards.length + " 件";
      if (emptyNote) emptyNote.hidden = visible > 0;
    };

    textInput.addEventListener("input", applyFilters);
    selects.forEach((select) => select.addEventListener("change", applyFilters));
    applyFilters();
  }

  document.querySelectorAll("[data-status-select]").forEach((select) => {
    select.addEventListener("change", async () => {
      const card = select.closest("[data-card]");
      const previous = card.dataset.status;
      select.disabled = true;
      try {
        const response = await fetch("/feedback/" + encodeURIComponent(select.dataset.feedbackId) + "/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: select.value })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Status update failed");
        card.dataset.status = select.value;
      } catch (error) {
        select.value = previous;
        window.alert(error.message);
      } finally {
        select.disabled = false;
      }
    });
  });
})();
</script>`;
}

function renderImportScript() {
  return `<script>
(() => {
  const form = document.querySelector("[data-import-form]");
  if (!form) return;
  const input = form.querySelector("[data-import-file]");
  const status = form.querySelector("[data-import-status]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.dataset.state = "";
    const file = input.files && input.files[0];
    if (!file) {
      status.dataset.state = "error";
      status.textContent = "Choose a JSON bundle first.";
      return;
    }

    status.textContent = "Importing...";
    try {
      const text = await file.text();
      const response = await fetch("/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Import failed");
      }
      status.textContent = "Imported " + (result.id || "feedback") + ". Reloading...";
      window.location.reload();
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error.message;
    }
  });
})();
</script>`;
}

function renderScreenshotPreview(screenshot) {
  if (!screenshot) return "";
  if (screenshot.status === "saved" && screenshot.url) {
    const url = escapeHtml(screenshot.url);
    const size = screenshot.width && screenshot.height
      ? `${screenshot.width}×${screenshot.height}`
      : "";
    const bytes = screenshot.bytes ? `${screenshot.bytes} bytes` : "";
    const caption = [size, bytes].filter(Boolean).join(" · ");
    return `
        <figure class="screenshot">
          <a href="${url}" target="_blank" rel="noopener">
            <img src="${url}" alt="PatchLoop screenshot preview" />
          </a>
          <figcaption>${escapeHtml(caption || "screenshot saved")}</figcaption>
        </figure>
    `;
  }

  return `<p class="screenshot-note">Screenshot: ${escapeHtml(formatScreenshotStatus(screenshot))}</p>`;
}

function formatSlackStatus(slack) {
  if (!slack) return "unknown";
  const image = slack.image && slack.image.status
    ? `, image ${slack.image.status}`
    : "";
  if (slack.status === "sent") return `sent${slack.statusCode ? ` (${slack.statusCode})` : ""}${image}`;
  if (slack.status === "failed") return `failed${slack.statusCode ? ` (${slack.statusCode})` : ""}: ${slack.error || "unknown error"}`;
  return slack.status || "unknown";
}
