"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { truncateText, present, escapeHtml, slackEscape, formatSlackCode, formatSlackLink, formatViewport, formatTarget } = require("../shared/format.js");
const { createStore } = require("./store.js");

const CONFIG_PATH = process.env.PATCHLOOP_RECEIVER_CONFIG || path.join(__dirname, "receiver.config.json");
const config = loadConfig(CONFIG_PATH);
const configDir = path.dirname(CONFIG_PATH);

const PORT = numberSetting(process.env.PORT, numberSetting(config.port, 4000));
const HOST = process.env.HOST || config.host || "127.0.0.1";
const LEGACY_STORE_PATH = process.env.FEEDBACK_STORE_PATH || pathFromConfig(config.feedbackStorePath, path.join(__dirname, "feedback.json"));
const DB_PATH = process.env.FEEDBACK_DB_PATH || pathFromConfig(config.feedbackDbPath, path.join(__dirname, "feedback.db"));
const MAX_BODY_BYTES = numberSetting(process.env.MAX_BODY_BYTES, numberSetting(config.maxBodyBytes, 3_000_000));
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || pathFromConfig(config.screenshotDir, path.join(__dirname, "screenshots"));
const SCREENSHOT_MAX_BYTES = numberSetting(process.env.SCREENSHOT_MAX_BYTES, numberSetting(config.screenshotMaxBytes, 1_500_000));
const WIDGET_DIST_PATH = path.join(__dirname, "..", "dist", "patchloop-widget.js");
const STATIC_DIR = path.join(__dirname, "static");
const PUBLIC_BASE_URL = trimTrailingSlash(process.env.PUBLIC_BASE_URL || config.publicBaseUrl || `http://${HOST}:${PORT}`);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || config.slackWebhookUrl || "";
const SLACK_TIMEOUT_MS = numberSetting(process.env.SLACK_TIMEOUT_MS, numberSetting(config.slackTimeoutMs, 5000));
const SLACK_IMAGE_MODE = normalizeSlackImageMode(process.env.SLACK_IMAGE_MODE || config.slackImageMode || "auto");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || config.slackBotToken || "";
const SLACK_UPLOAD_CHANNEL_ID = process.env.SLACK_UPLOAD_CHANNEL_ID || config.slackUploadChannelId || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || config.githubToken || "";
const GITHUB_REPO = normalizeGitHubRepo(process.env.GITHUB_REPO || config.githubRepo || "");
const GITHUB_LABELS = normalizeStringList(process.env.GITHUB_LABELS || config.githubLabels);
const GITHUB_ASSIGNEES = normalizeStringList(process.env.GITHUB_ASSIGNEES || config.githubAssignees);
const GITHUB_API_BASE = trimTrailingSlash(process.env.GITHUB_API_BASE || config.githubApiBase || "https://api.github.com");
const GITHUB_TIMEOUT_MS = numberSetting(process.env.GITHUB_TIMEOUT_MS, numberSetting(config.githubTimeoutMs, 8000));
const GITHUB_CONFIGURED = Boolean(GITHUB_TOKEN && GITHUB_REPO);
const IMPORT_BUNDLE_KIND = "patchloop-feedback-bundle";
// v1 wrapped a single feedback object; v2 carries an array (batch export).
// Both are accepted so files exported before the batch-download switch still
// import.
const SUPPORTED_IMPORT_BUNDLE_VERSIONS = new Set([1, 2]);
const FEEDBACK_STATUSES = ["new", "accepted", "fixed", "ignored"];
// Default applied to payloads received before the widget sent schemaVersion,
// so every stored item carries a version going forward.
const DEFAULT_SCHEMA_VERSION = 1;

let store;

const server = http.createServer((req, res) => {
  setCors(res);

  // Routes match the pathname so query strings (e.g. /feedback.json?v=2)
  // cannot turn a valid endpoint into a 404.
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch (_) {
    pathname = req.url;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && pathname === "/feedback") {
    handlePostFeedback(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/import") {
    handlePostImport(req, res);
    return;
  }

  const deleteMatch = req.method === "DELETE" && /^\/feedback\/([^/]+)$/.exec(pathname);
  if (deleteMatch) {
    handleDeleteFeedback(req, res, decodeURIComponent(deleteMatch[1]));
    return;
  }

  const statusMatch = req.method === "POST" && /^\/feedback\/([^/]+)\/status$/.exec(pathname);
  if (statusMatch) {
    handlePostStatus(req, res, decodeURIComponent(statusMatch[1]));
    return;
  }

  const githubMatch = req.method === "POST" && /^\/feedback\/([^/]+)\/github-issue$/.exec(pathname);
  if (githubMatch) {
    handlePostGitHubIssue(req, res, decodeURIComponent(githubMatch[1]));
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    handleGetInbox(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/feedback.json") {
    handleGetFeedbackJson(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/widget.js") {
    handleGetWidgetScript(req, res);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/static/")) {
    handleGetStaticAsset(req, res);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/screenshots/")) {
    handleGetScreenshot(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

// Storage is initialized (and the legacy JSON store migrated) before the
// server accepts requests, so no handler can run against an unready store.
async function start() {
  store = createStore({ dbPath: DB_PATH, legacyJsonPath: LEGACY_STORE_PATH });
  await store.init();

  server.listen(PORT, HOST, () => {
    console.log(`[PatchLoop receiver] listening on http://${HOST}:${PORT}`);
    console.log(`[PatchLoop receiver] config file: ${config.__loaded ? CONFIG_PATH : "not loaded"}`);
    console.log(`[PatchLoop receiver] feedback db: ${DB_PATH}`);
    console.log(`[PatchLoop receiver] screenshot dir: ${SCREENSHOT_DIR}`);
    console.log(`[PatchLoop receiver] Slack webhook: ${SLACK_WEBHOOK_URL ? "enabled" : "disabled"}`);
    console.log(`[PatchLoop receiver] Slack image mode: ${SLACK_IMAGE_MODE}`);
    console.log(`[PatchLoop receiver] Slack file upload: ${SLACK_BOT_TOKEN && SLACK_UPLOAD_CHANNEL_ID ? "enabled" : "disabled"}`);
    console.log(`[PatchLoop receiver] GitHub issues: ${GITHUB_CONFIGURED ? `enabled (${GITHUB_REPO})` : "disabled"}`);
  });
}

start().catch((error) => {
  console.error(`[PatchLoop receiver] failed to start: ${error.message}`);
  process.exit(1);
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Number("") is 0 and Number("abc") is NaN; both would silently disable or
// corrupt a limit, so blank and non-numeric settings fall back instead.
function numberSetting(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function normalizeGitHubRepo(value) {
  const repo = String(value || "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : "";
}

function normalizeStringList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return items.map((item) => String(item).trim()).filter(Boolean);
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

    const stored = {
      receivedAt: new Date().toISOString(),
      schemaVersion: DEFAULT_SCHEMA_VERSION,
      ...payload,
      screenshot
    };
    stored.integrations = {
      ...(stored.integrations || {}),
      slack: await deliverToSlack(stored)
    };
    await store.insert(stored);
    const slackLog = stored.integrations.slack.status === "disabled"
      ? ""
      : ` slack=${stored.integrations.slack.status}`;
    console.log(`[PatchLoop receiver] received feedback id=${payload?.id || "?"} comment="${truncateText(payload?.comment || "", 60)}"${slackLog}`);
    respondJson(res, 201, {
      ok: true,
      id: payload?.id,
      count: await store.count(),
      slack: stored.integrations.slack
    });
  });
}

function handlePostImport(req, res) {
  readJsonBody(req, res, async (body) => {
    let importedList;
    try {
      importedList = normalizeImportedBundle(body);
    } catch (error) {
      respondJson(res, error.statusCode || 400, { ok: false, error: error.message });
      return;
    }

    const now = new Date().toISOString();
    const ids = [];
    const duplicates = [];
    const failed = [];

    // Best-effort per item: a duplicate id (re-imported batch) is skipped, not
    // fatal, so the rest of the bundle still lands. Validation already ran for
    // the whole list, so failures here are write-time only.
    for (const imported of importedList) {
      let screenshot;
      try {
        screenshot = saveScreenshot(imported.screenshot, imported.id);
      } catch (error) {
        failed.push({ id: imported.id, error: error.message });
        continue;
      }

      const stored = {
        schemaVersion: DEFAULT_SCHEMA_VERSION,
        ...imported,
        receivedAt: now,
        importedAt: now,
        source: "import",
        screenshot,
        integrations: {
          slack: { status: "skipped", reason: "import" }
        }
      };

      try {
        await store.insert(stored);
        ids.push(stored.id);
        console.log(`[PatchLoop receiver] imported feedback id=${stored.id || "?"} comment="${truncateText(stored.comment || "", 60)}"`);
      } catch (error) {
        // The insert failed, so drop the screenshot we just wrote for it
        // (saveScreenshot names files uniquely, so this never touches an
        // existing record's screenshot).
        await deleteScreenshotFile(screenshot);
        if (error.statusCode === 409) {
          duplicates.push(stored.id);
        } else {
          failed.push({ id: stored.id, error: error.message });
        }
      }
    }

    const status = ids.length > 0 ? 201 : duplicates.length > 0 ? 409 : 400;
    respondJson(res, status, {
      ok: ids.length > 0,
      id: ids[0],
      ids,
      imported: ids.length,
      duplicates,
      failed,
      count: await store.count(),
      source: "import"
    });
  });
}

async function handleDeleteFeedback(req, res, id) {
  let removed;
  try {
    removed = await store.delete(id);
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
    return;
  }
  if (!removed) {
    respondJson(res, 404, { ok: false, error: `Unknown feedback id: ${id}` });
    return;
  }

  // Await the file removal so a 200 means the screenshot is gone too.
  await deleteScreenshotFile(removed.screenshot);
  console.log(`[PatchLoop receiver] deleted feedback id=${id}`);
  respondJson(res, 200, { ok: true, id, count: await store.count() });
}

// Removes the stored screenshot for a deleted feedback. Confined to
// SCREENSHOT_DIR so a tampered stored path cannot delete arbitrary files,
// and missing files are ignored (the feedback is already gone).
async function deleteScreenshotFile(screenshot) {
  const storedPath = screenshot && screenshot.path;
  if (!storedPath) return;
  const resolved = path.resolve(storedPath);
  const root = path.resolve(SCREENSHOT_DIR);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return;
  try {
    await fs.promises.rm(resolved, { force: true });
  } catch (error) {
    console.warn(`[PatchLoop receiver] could not delete screenshot ${resolved}: ${error.message}`);
  }
}

function handlePostStatus(req, res, id) {
  readJsonBody(req, res, async (body) => {
    const status = body && body.status;
    if (!FEEDBACK_STATUSES.includes(status)) {
      respondJson(res, 400, { ok: false, error: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}` });
      return;
    }

    const updated = await store.update(id, { status, statusUpdatedAt: new Date().toISOString() });
    if (!updated) {
      respondJson(res, 404, { ok: false, error: `Unknown feedback id: ${id}` });
      return;
    }

    respondJson(res, 200, { ok: true, id, status });
  });
}

function handlePostGitHubIssue(req, res, id) {
  readJsonBody(req, res, async () => {
    if (!GITHUB_CONFIGURED) {
      respondJson(res, 400, { ok: false, error: "GitHub integration is not configured. Set GITHUB_TOKEN and GITHUB_REPO." });
      return;
    }

    const item = await store.get(id);
    if (!item) {
      respondJson(res, 404, { ok: false, error: `Unknown feedback id: ${id}` });
      return;
    }

    const existing = item.integrations && item.integrations.github;
    if (existing && existing.status === "created") {
      respondJson(res, 409, { ok: false, error: `GitHub issue already created: ${existing.url || `#${existing.issueNumber}`}`, github: existing });
      return;
    }

    const github = await createGitHubIssue(item);
    await store.update(id, { integrations: { ...(item.integrations || {}), github } });
    console.log(`[PatchLoop receiver] github issue ${github.status} id=${id}${github.url ? ` url=${github.url}` : ""}`);

    if (github.status === "created") {
      respondJson(res, 201, { ok: true, github });
    } else {
      respondJson(res, 502, { ok: false, error: github.error || "GitHub issue creation failed", github });
    }
  });
}

async function createGitHubIssue(item) {
  const issue = {
    title: gitHubIssueTitle(item),
    body: gitHubIssueBody(item)
  };
  if (GITHUB_LABELS.length) issue.labels = GITHUB_LABELS;
  if (GITHUB_ASSIGNEES.length) issue.assignees = GITHUB_ASSIGNEES;

  try {
    const response = await postJson(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/issues`, issue, {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }, GITHUB_TIMEOUT_MS);

    if (response.statusCode === 201) {
      let parsed = {};
      try {
        parsed = JSON.parse(response.body);
      } catch (_) {
        // Issue was created; metadata stays partial if the body is unreadable.
      }
      return {
        status: "created",
        issueNumber: parsed.number ?? null,
        url: parsed.html_url || "",
        createdAt: new Date().toISOString()
      };
    }

    return {
      status: "failed",
      statusCode: response.statusCode,
      error: truncateText(gitHubErrorMessage(response.body) || "GitHub API returned a non-201 response", 240),
      failedAt: new Date().toISOString()
    };
  } catch (error) {
    return { status: "failed", error: error.message, failedAt: new Date().toISOString() };
  }
}

function gitHubErrorMessage(raw) {
  try {
    return JSON.parse(raw).message || "";
  } catch (_) {
    return String(raw || "");
  }
}

function gitHubIssueTitle(item) {
  const firstLine = String(item.comment || "").split("\n")[0].trim() || "(no comment)";
  return `[PatchLoop] ${truncateText(firstLine, 80)}`;
}

function gitHubIssueBody(item) {
  const target = item.target || {};
  const env = item.environment || {};
  const page = item.page || {};
  const lines = [];

  lines.push("## Feedback", "");
  lines.push(...String(item.comment || "(empty comment)").split("\n").map((line) => `> ${line}`), "");
  lines.push("| | |");
  lines.push("|---|---|");
  const pageLink = mdLinkUrl(page.url);
  lines.push(`| Reviewer | ${mdTableCell(item.reviewer || "(no name)")} |`);
  lines.push(`| Page | ${pageLink ? `[${mdTableCell(page.title || page.url)}](${pageLink})` : mdTableCell(page.title || page.url || "(unknown)")} |`);
  lines.push(`| Target | ${mdTableCell(formatTarget(target))} |`);
  lines.push(`| Selector | \`${String(target.selector || "(none)").replaceAll("\`", "'")}\` |`);
  lines.push(`| Viewport | ${mdTableCell(formatViewport(env.viewport))} |`);
  lines.push(`| Created | ${mdTableCell(item.createdAt || item.receivedAt || "(unknown)")} |`);
  lines.push(`| Feedback ID | \`${String(item.id || "-").replaceAll("\`", "'")}\` |`);
  lines.push("");

  if (target.text) {
    lines.push("### Element text", "");
    lines.push(...truncateText(String(target.text), 500).split("\n").map((line) => `> ${line}`), "");
  }

  const screenshotUrl = screenshotUrlFor(item.screenshot);
  if (screenshotUrl) {
    lines.push("### Screenshot", "");
    lines.push(`![PatchLoop screenshot](${screenshotUrl})`, "");
    lines.push(`[Open screenshot](${screenshotUrl})`, "");
    lines.push("_The image only renders if the receiver's `publicBaseUrl` is reachable from GitHub._", "");
  } else if (item.screenshot && item.screenshot.status) {
    lines.push(`Screenshot: ${formatScreenshotStatus(item.screenshot)}`, "");
  }

  lines.push("<details><summary>Raw payload</summary>", "");
  lines.push("```json");
  lines.push(JSON.stringify(item, null, 2));
  lines.push("```");
  lines.push("", "</details>", "");
  lines.push("---");
  lines.push("_Created from the PatchLoop receiver inbox._");
  return lines.join("\n");
}

function mdTableCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
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
      // Respond and drain the rest instead of destroying the socket:
      // an immediate destroy races the 413 and clients see ECONNRESET.
      chunks.length = 0;
      respondJson(res, 413, { ok: false, error: "Payload too large" });
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;
    let payload;
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      payload = raw.trim() ? JSON.parse(raw) : {};
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
    if (aborted || res.headersSent) return;
    respondJson(res, 500, { ok: false, error: error.message });
  });
}

// Resolves a bundle (single or batch) into a list of normalized payloads.
// Validation runs over every payload up front, so a batch with one bad item
// is rejected whole before anything is written.
function normalizeImportedBundle(body) {
  requirePlainObject(body, "Import body");

  let feedback;
  if (body.kind === IMPORT_BUNDLE_KIND) {
    if (!SUPPORTED_IMPORT_BUNDLE_VERSIONS.has(body.version)) {
      throw httpError(`Unsupported PatchLoop bundle version: ${body.version}`, 400);
    }
    // Each version pins its feedback shape, so a malformed producer (v1 array
    // or v2 single object) is rejected instead of silently reinterpreted.
    if (body.version === 1 && Array.isArray(body.feedback)) {
      throw httpError("PatchLoop bundle version 1 expects a single feedback object", 400);
    }
    if (body.version === 2 && !Array.isArray(body.feedback)) {
      throw httpError("PatchLoop bundle version 2 expects a feedback array", 400);
    }
    feedback = body.feedback;
  } else if (body.feedback !== undefined) {
    feedback = body.feedback;
  } else {
    feedback = body;
  }

  const list = Array.isArray(feedback) ? feedback : [feedback];
  if (list.length === 0) {
    throw httpError("Import bundle contains no feedback", 400);
  }
  return list.map(normalizeImportedPayload);
}

function normalizeImportedPayload(payload) {
  validateFeedbackPayload(payload);
  const imported = JSON.parse(JSON.stringify(payload));
  delete imported.delivery;
  delete imported.integrations;
  delete imported.receivedAt;
  delete imported.importedAt;
  delete imported.source;
  // Local-only export markers (set by the widget after a batch download) must
  // never reach the stored record.
  delete imported.exported;
  delete imported.exportedAt;
  delete imported.exportedFileName;
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

  if (payload.schemaVersion != null && !Number.isInteger(payload.schemaVersion)) {
    throw httpError("feedback.schemaVersion must be an integer", 400);
  }
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
  if (payload.screenshot != null) {
    requirePlainObject(payload.screenshot, "feedback.screenshot");
    validateScreenshotContent(payload.screenshot);
  }
}

// Validates the screenshot's data URL / mime / size without writing a file, so
// a batch import can reject every bad item up front (preserving the all-or-
// nothing guarantee) instead of failing mid-write after some inserts landed.
// Mirrors the checks saveScreenshot performs before persisting.
function validateScreenshotContent(screenshot) {
  if (screenshot.status && screenshot.status !== "captured") return;
  if (!screenshot.dataUrl) return;
  const parsed = parseDataUrl(screenshot.dataUrl);
  if (!extensionForMimeType(parsed.mimeType)) {
    throw httpError(`Unsupported screenshot mime type: ${parsed.mimeType}`, 400);
  }
  if (parsed.buffer.length > SCREENSHOT_MAX_BYTES) {
    throw httpError(`Screenshot too large: ${parsed.buffer.length} bytes exceeds ${SCREENSHOT_MAX_BYTES}`, 413);
  }
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

async function handleGetInbox(req, res) {
  try {
    const items = await store.list({});
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderInbox(items));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
    console.warn(`[PatchLoop receiver] inbox render failed: ${error.message}`);
  }
}

// GET /feedback.json supports ?projectId=&demoId=&status= to narrow the
// export, so a shared receiver can hand each project just its own feedback.
async function handleGetFeedbackJson(req, res) {
  let params;
  try {
    params = new URL(req.url, "http://localhost").searchParams;
  } catch (_) {
    respondJson(res, 400, { ok: false, error: "Invalid query" });
    return;
  }

  // Empty query values mean "no filter" (matching the inbox's "all" option),
  // not "items whose field equals the empty string".
  const projectId = params.get("projectId") || null;
  const demoId = params.get("demoId") || null;
  const status = params.get("status") || null;

  if (status != null && !FEEDBACK_STATUSES.includes(status)) {
    respondJson(res, 400, { ok: false, error: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}` });
    return;
  }

  try {
    const filter = {};
    if (projectId != null) filter.projectId = projectId;
    if (demoId != null) filter.demoId = demoId;
    if (status != null) filter.status = status;
    respondJson(res, 200, await store.list(filter));
  } catch (error) {
    respondJson(res, 500, { ok: false, error: error.message });
  }
}

function handleGetWidgetScript(req, res) {
  fs.readFile(WIDGET_DIST_PATH, (error, buffer) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Widget bundle not found. Run `npm run build` first.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(buffer);
  });
}

function handleGetStaticAsset(req, res) {
  let filename;
  try {
    const url = new URL(req.url, "http://localhost");
    filename = path.basename(decodeURIComponent(url.pathname));
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid asset path");
    return;
  }

  const assetPath = path.resolve(STATIC_DIR, filename);
  const staticRoot = path.resolve(STATIC_DIR);
  if (!assetPath.startsWith(`${staticRoot}${path.sep}`)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  fs.readFile(assetPath, (error, buffer) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeForPath(assetPath),
      "Cache-Control": "no-store"
    });
    res.end(buffer);
  });
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
  const random = crypto.randomUUID().slice(0, 8);
  const fileName = `${safeFilePart(id || "feedback")}-${Date.now()}-${random}.${extension}`;
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
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
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

// escapeHtml cannot stop a javascript: URL inside an href attribute; only
// plain http(s) targets may become links. Returns "" for everything else.
function safeLinkUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

// Markdown link destinations are wrapped in <> so spaces and parentheses
// cannot terminate the link; encode the characters that end the <> form so
// user-controlled URLs cannot break out into raw markdown.
function mdLinkUrl(value) {
  const url = safeLinkUrl(value);
  if (!url) return "";
  return `<${url.replaceAll("<", "%3C").replaceAll(">", "%3E").replace(/\s/g, "%20")}>`;
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
    if (image.status === "skipped") {
      return { status: "skipped", reason: image.reason };
    }
    return { status: "failed", image, error: image.error || "Slack file upload failed" };
  }

  try {
    const response = await postJson(SLACK_WEBHOOK_URL, buildSlackMessage(item));
    const result = response.statusCode >= 200 && response.statusCode < 300
      ? { status: "sent", statusCode: response.statusCode }
      : {
          status: "failed",
          statusCode: response.statusCode,
          error: truncateText(response.body || "Slack webhook returned a non-2xx response", 240)
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

function postJson(targetUrl, body, extraHeaders = {}, timeoutMs = SLACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (error) {
      reject(new Error(`Invalid request URL: ${error.message}`));
      return;
    }

    const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!client) {
      reject(new Error(`Unsupported request protocol: ${url.protocol}`));
      return;
    }

    const json = JSON.stringify(body);
    const request = client.request(url, {
      method: "POST",
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
        "User-Agent": "PatchLoop receiver",
        ...extraHeaders
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
      request.destroy(new Error(`Request to ${url.hostname} timed out after ${timeoutMs}ms`));
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
        error: truncateText(uploadResponse.body || "upload_url returned a non-2xx response", 240)
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
  const comment = slackEscape(truncateText(item.comment || "(empty comment)", 1400));
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
        text: `*Element text*\n>${slackEscape(truncateText(target.text, 500)).replaceAll("\n", "\n>")}`
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
    text: `PatchLoop feedback: ${truncateText(item.comment || "", 120)}`,
    blocks
  };
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
    const project = escapeHtml(item.projectId || "");
    const demo = escapeHtml(item.demoId || "");
    const importedAt = escapeHtml(item.importedAt || "");
    const status = feedbackStatusOf(item);
    const slackStatus = escapeHtml((slack && slack.status) || "unknown");
    const github = item.integrations && item.integrations.github;
    const githubStatus = escapeHtml((github && github.status) || "none");
    const searchText = escapeHtml([item.comment, item.reviewer, target.selector, page.url, page.title, item.id]
      .filter(Boolean).join(" ").toLowerCase());
    const statusOptions = FEEDBACK_STATUSES
      .map((value) => `<option value="${value}"${value === status ? " selected" : ""}>${value}</option>`)
      .join("");
    const viewport = env.viewport
      ? `${env.viewport.width}×${env.viewport.height}`
      : "";
    return `
      <article class="card" data-card data-status="${status}" data-kind="${kind}" data-project="${project}" data-demo="${demo}" data-reviewer="${reviewer}" data-source="${source}" data-slack="${slackStatus}" data-github="${githubStatus}" data-search="${searchText}">
        <header>
          <span class="kind kind-${kind}">${kind}</span>
          <span class="reviewer">${reviewer || "(no name)"}</span>
          <label class="status-control">
            <select data-status-select data-feedback-id="${escapeHtml(item.id || "")}">${statusOptions}</select>
          </label>
          <time>${receivedAt}</time>
          <button type="button" class="delete-feedback" data-delete-feedback data-feedback-id="${escapeHtml(item.id || "")}" title="この feedback を削除">削除</button>
        </header>
        <p class="comment">${comment}</p>
        ${renderScreenshotPreview(screenshot)}
        <dl>
          <div><dt>URL</dt><dd>${safeLinkUrl(page.url) ? `<a href="${escapeHtml(safeLinkUrl(page.url))}" target="_blank" rel="noopener">${pageUrl}</a>` : pageUrl}</dd></div>
          <div><dt>Title</dt><dd>${pageTitle}</dd></div>
          <div><dt>Selector</dt><dd><code>${selector}</code></dd></div>
          <div><dt>Viewport</dt><dd>${escapeHtml(viewport)}</dd></div>
          <div><dt>Source</dt><dd>${source}</dd></div>
          <div><dt>Slack</dt><dd>${escapeHtml(formatSlackStatus(slack))}</dd></div>
          <div><dt>GitHub</dt><dd>${renderGitHubCell(github, item.id)}</dd></div>
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
  <link rel="stylesheet" href="/static/inbox.css" />
</head>
<body>
  <h1>PatchLoop Inbox</h1>
  <p class="meta">${items.length} feedback received · <a href="/feedback.json">raw JSON</a></p>
  ${renderImportPanel()}
  ${items.length === 0 ? "" : renderFilterPanel(items)}
  ${items.length === 0 ? '<p class="empty">まだフィードバックはありません。widget からコメントを送ると、ここに表示されます。</p>' : cards.join("")}
  <p class="empty" data-filter-empty hidden>絞り込みに一致する feedback はありません。</p>
  <script src="/static/inbox.js"></script>
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
  const projects = unique((item) => item.projectId || "");
  const demos = unique((item) => item.demoId || "");
  const reviewers = unique((item) => item.reviewer || "");
  const sources = unique((item) => item.source || "receiver");
  const slackStatuses = unique((item) => (item.integrations && item.integrations.slack && item.integrations.slack.status) || "unknown");
  const githubStatuses = unique((item) => (item.integrations && item.integrations.github && item.integrations.github.status) || "none");

  return `
  <section class="filter-panel" data-filter-panel>
    <input type="search" placeholder="検索（コメント / reviewer / selector / URL）" data-filter-text />
    <select data-filter-key="status">${optionList(FEEDBACK_STATUSES, "Status: all")}</select>
    <select data-filter-key="kind">${optionList(["point", "area"], "Kind: all")}</select>
    <select data-filter-key="project">${optionList(projects, "Project: all")}</select>
    <select data-filter-key="demo">${optionList(demos, "Demo: all")}</select>
    <select data-filter-key="reviewer">${optionList(reviewers, "Reviewer: all")}</select>
    <select data-filter-key="source">${optionList(sources, "Source: all")}</select>
    <select data-filter-key="slack">${optionList(slackStatuses, "Slack: all")}</select>
    <select data-filter-key="github">${optionList(githubStatuses, "GitHub: all")}</select>
    <span class="filter-count" data-filter-count></span>
  </section>`;
}

function renderGitHubCell(github, id) {
  if (github && github.status === "created") {
    const number = github.issueNumber != null ? `#${escapeHtml(String(github.issueNumber))}` : "issue";
    const url = safeLinkUrl(github.url);
    return url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${number} created</a>`
      : `${number} created`;
  }

  if (!GITHUB_CONFIGURED) return "not configured";

  const button = `<button type="button" class="github-create" data-github-create data-feedback-id="${escapeHtml(id || "")}">Create GitHub Issue</button>`;
  if (github && github.status === "failed") {
    const code = github.statusCode ? ` (${escapeHtml(String(github.statusCode))})` : "";
    return `<span class="github-error">failed${code}: ${escapeHtml(github.error || "unknown error")}</span> ${button}`;
  }
  return button;
}

function renderScreenshotPreview(screenshot) {
  if (!screenshot) return "";
  if (screenshot.status === "saved" && safeLinkUrl(screenshot.url)) {
    const url = escapeHtml(safeLinkUrl(screenshot.url));
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
