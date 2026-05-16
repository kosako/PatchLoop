"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const STORE_PATH = path.join(__dirname, "feedback.json");
const MAX_BODY_BYTES = 1_000_000;

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

  req.on("end", () => {
    if (aborted) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (_) {
      respondJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const stored = { receivedAt: new Date().toISOString(), ...payload };
    feedback.unshift(stored);
    persist();
    console.log(`[PatchLoop receiver] received feedback id=${payload?.id || "?"} comment="${truncate(payload?.comment || "", 60)}"`);
    respondJson(res, 201, { ok: true, id: payload?.id, count: feedback.length });
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

function renderInbox(items) {
  const cards = items.map((item) => {
    const target = item.target || {};
    const env = item.environment || {};
    const page = item.page || {};
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
