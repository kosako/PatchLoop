"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const STORE_PATH = process.env.FEEDBACK_STORE_PATH || path.join(__dirname, "feedback.json");
const MAX_BODY_BYTES = 1_000_000;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const SLACK_TIMEOUT_MS = Number(process.env.SLACK_TIMEOUT_MS || 5000);

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

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    handleGetInbox(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/feedback.json") {
    respondJson(res, 200, feedback);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`[PatchLoop receiver] listening on http://${HOST}:${PORT}`);
  console.log(`[PatchLoop receiver] feedback file: ${STORE_PATH}`);
  console.log(`[PatchLoop receiver] Slack webhook: ${SLACK_WEBHOOK_URL ? "enabled" : "disabled"}`);
});

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function handlePostFeedback(req, res) {
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
    const stored = { receivedAt: new Date().toISOString(), ...payload };
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

  req.on("error", (error) => {
    if (aborted) return;
    respondJson(res, 500, { ok: false, error: error.message });
  });
}

function handleGetInbox(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderInbox(feedback));
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
  fs.writeFileSync(STORE_PATH, JSON.stringify(feedback, null, 2));
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
    return { status: "disabled" };
  }

  try {
    const response = await postJson(SLACK_WEBHOOK_URL, buildSlackMessage(item));
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { status: "sent", statusCode: response.statusCode };
    }
    return {
      status: "failed",
      statusCode: response.statusCode,
      error: truncate(response.body || "Slack webhook returned a non-2xx response", 240)
    };
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

function buildSlackMessage(item) {
  const target = item.target || {};
  const env = item.environment || {};
  const page = item.page || {};
  const comment = slackEscape(truncate(item.comment || "(empty comment)", 1400));
  const pageText = page.url
    ? formatSlackLink(page.url, page.title || page.url)
    : slackEscape(page.title || "(unknown page)");

  return {
    text: `PatchLoop feedback: ${truncate(item.comment || "", 120)}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*PatchLoop feedback*\n${comment}`
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
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `project: ${formatSlackCode(item.projectId || "-")} · demo: ${formatSlackCode(item.demoId || "-")}`
          }
        ]
      }
    ]
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

function renderInbox(items) {
  const cards = items.map((item) => {
    const target = item.target || {};
    const env = item.environment || {};
    const page = item.page || {};
    const slack = item.integrations && item.integrations.slack;
    const kind = escapeHtml(target.kind || "?");
    const selector = escapeHtml(target.selector || "");
    const pageUrl = escapeHtml(page.url || "");
    const pageTitle = escapeHtml(page.title || "");
    const comment = escapeHtml(item.comment || "");
    const reviewer = escapeHtml(item.reviewer || "");
    const createdAt = escapeHtml(item.createdAt || "");
    const receivedAt = escapeHtml(item.receivedAt || "");
    const viewport = env.viewport
      ? `${env.viewport.width}×${env.viewport.height}`
      : "";
    return `
      <article class="card">
        <header>
          <span class="kind kind-${kind}">${kind}</span>
          <span class="reviewer">${reviewer || "(no name)"}</span>
          <time>${receivedAt}</time>
        </header>
        <p class="comment">${comment}</p>
        <dl>
          <div><dt>URL</dt><dd><a href="${pageUrl}" target="_blank" rel="noopener">${pageUrl}</a></dd></div>
          <div><dt>Title</dt><dd>${pageTitle}</dd></div>
          <div><dt>Selector</dt><dd><code>${selector}</code></dd></div>
          <div><dt>Viewport</dt><dd>${escapeHtml(viewport)}</dd></div>
          <div><dt>Slack</dt><dd>${escapeHtml(formatSlackStatus(slack))}</dd></div>
          <div><dt>Created</dt><dd>${createdAt}</dd></div>
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
    .card { background: #fff; border: 1px solid #d9e1dd; border-radius: 8px; padding: 16px 18px; margin-bottom: 14px; box-shadow: 0 4px 12px rgba(20, 33, 29, 0.05); }
    .card header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; color: #65716d; }
    .kind { padding: 2px 8px; border-radius: 999px; font-weight: 800; color: #fff; font-size: 11px; text-transform: uppercase; }
    .kind-point { background: #0f7b63; }
    .kind-area { background: #d1495b; }
    .reviewer { font-weight: 700; color: #14211d; }
    time { margin-left: auto; }
    .comment { font-size: 15px; margin: 0 0 12px; white-space: pre-wrap; }
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
  ${items.length === 0 ? '<p class="empty">まだフィードバックはありません。widget からコメントを送ると、ここに表示されます。</p>' : cards.join("")}
</body>
</html>`;
}

function formatSlackStatus(slack) {
  if (!slack) return "unknown";
  if (slack.status === "sent") return `sent (${slack.statusCode})`;
  if (slack.status === "failed") return `failed${slack.statusCode ? ` (${slack.statusCode})` : ""}: ${slack.error || "unknown error"}`;
  return slack.status || "unknown";
}
