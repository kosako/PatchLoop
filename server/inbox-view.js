"use strict";

const { escapeHtml } = require("../shared/format.js");
const { FEEDBACK_STATUSES } = require("./store.js");

function createInboxView(deps) {
  const { formatScreenshotStatus, safeLinkUrl, GITHUB_CONFIGURED, RECEIVER_TOKEN } = deps;
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
  ${RECEIVER_TOKEN ? '<form class="logout-form" method="post" action="/logout"><button type="submit">ログアウト</button></form>' : ""}
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

  function renderLoginPage(failed) {
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PatchLoop Inbox — Login</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }
    label { display: block; margin-bottom: 0.75rem; }
    input { display: block; width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem; }
    button { padding: 0.5rem 1.25rem; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <h1>PatchLoop Inbox</h1>
  ${failed ? '<p class="error">トークンが違います。</p>' : ""}
  <form method="post" action="/login">
    <label>Access token
      <input type="password" name="token" autocomplete="current-password" autofocus required />
    </label>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
  }

  return { renderInbox, renderLoginPage };
}

module.exports = { createInboxView };
