"use strict";

const { escapeHtml, FEEDBACK_STATUS_LABELS: STATUS_LABELS } = require("../shared/format.js");
const { FEEDBACK_STATUSES } = require("./store.js");
const { feedbackForExport } = require("./feedback-export.js");
const { summarizeUncaptured } = require("./uncaptured.js");

const KIND_LABELS = { point: "ポイント", area: "範囲" };
const UNCAPTURED_RELATION_LABELS = { "covers-target": "指摘箇所の最前面", "overlaps-target": "指摘箇所に重なる" };

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "日時不明") : new Intl.DateTimeFormat("ja-JP", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function createInboxView(deps) {
  const { formatScreenshotStatus, safeLinkUrl, GITHUB_CONFIGURED, RECEIVER_TOKEN } = deps;
  function feedbackStatusOf(item) {
    return FEEDBACK_STATUSES.includes(item.status) ? item.status : "new";
  }

  function renderInbox(items) {
    const cards = items.map((item) => {
      try {
        return renderCard(item);
      } catch (_) {
        // Old stores may contain metadata accepted before shape validation.
        // Keep the record inspectable/removable without breaking other cards.
        const id = item && typeof item.id === "string" ? item.id : "";
        return `<article class="card" data-card data-status="new" data-kind="" data-project="" data-demo="" data-reviewer="" data-source="" data-slack="" data-github="" data-search="${escapeHtml(id.toLowerCase())}">
          <p>保存済みメタデータの形式が不正なため、この feedback の詳細を表示できません。</p>
          ${id ? `<button type="button" class="delete-feedback" data-delete-feedback data-feedback-id="${escapeHtml(id)}">削除</button>` : ""}
          <details><summary>raw payload</summary><pre>${escapeHtml(JSON.stringify(feedbackForExport(item), null, 2))}</pre></details>
        </article>`;
      }
    });

    function renderCard(item) {
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
      const searchText = escapeHtml([item.comment, item.reviewer, target.selector, page.url, page.title, item.id, item.projectId, item.demoId]
        .filter(Boolean).join(" ").toLowerCase());
      const statusOptions = FEEDBACK_STATUSES
        .map((value) => `<option value="${value}"${value === status ? " selected" : ""}>${STATUS_LABELS[value]}</option>`)
        .join("");
      const viewport = env.viewport
        ? `${env.viewport.width}×${env.viewport.height}`
        : "";
      // Only a saved screenshot comes with a check of what it cannot show (#148).
      const uncaptured = screenshot && screenshot.status === "saved" ? summarizeUncaptured(screenshot) : null;
      return `
      <article class="card" data-card data-status="${status}" data-kind="${kind}" data-project="${project}" data-demo="${demo}" data-reviewer="${reviewer}" data-source="${source}" data-slack="${slackStatus}" data-github="${githubStatus}" data-search="${searchText}">
        <header class="card-header">
          <span class="kind kind-${kind}">${escapeHtml(KIND_LABELS[target.kind] || "その他")}</span>
          <span class="reviewer">${reviewer || "投稿者不明"}</span>
          <time datetime="${receivedAt}" title="${receivedAt}">${escapeHtml(displayDate(item.receivedAt))}</time>
        </header>
        <div class="card-content">
          <div class="card-copy">
            <p class="card-context">${project || "プロジェクト未指定"}${demo ? ` <span>/</span> ${demo}` : ""}</p>
            <p class="comment">${comment}</p>
            <p class="page-link">${safeLinkUrl(page.url) ? `<a href="${escapeHtml(safeLinkUrl(page.url))}" target="_blank" rel="noopener">${pageTitle || pageUrl}<span class="sr-only">（新しいタブで開く）</span></a>` : pageTitle || pageUrl}</p>
            ${renderUncapturedNote(uncaptured)}
          </div>
          ${renderScreenshotPreview(screenshot)}
        </div>
        <div class="card-actions">
          <label class="status-control">
            <span>対応状況</span>
            <select data-status-select data-feedback-id="${escapeHtml(item.id || "")}" aria-label="フィードバックのステータス">${statusOptions}</select>
          </label>
          <span class="github-cell" data-github-cell>${renderGitHubCell(github, item.id)}</span>
        </div>
        <p class="action-status" data-action-status role="status" aria-live="polite" hidden></p>
        <details class="card-details">
          <summary>詳細・連携情報</summary>
        <dl>
          <div><dt>URL</dt><dd>${safeLinkUrl(page.url) ? `<a href="${escapeHtml(safeLinkUrl(page.url))}" target="_blank" rel="noopener">${pageUrl}</a>` : pageUrl}</dd></div>
          <div><dt>Title</dt><dd>${pageTitle}</dd></div>
          <div><dt>Selector</dt><dd><code>${selector}</code></dd></div>
          <div><dt>Viewport</dt><dd>${escapeHtml(viewport)}</dd></div>
          ${uncaptured ? `<div><dt>写らない要素</dt><dd>${escapeHtml(uncapturedSummaryText(uncaptured))}</dd></div>` : ""}
          <div><dt>Source</dt><dd>${source}</dd></div>
          <div><dt>Slack</dt><dd>${escapeHtml(formatSlackStatus(slack))}</dd></div>
          <div><dt>GitHub</dt><dd>${githubStatus}</dd></div>
          <div><dt>Created</dt><dd>${createdAt}</dd></div>
          ${importedAt ? `<div><dt>Imported</dt><dd>${importedAt}</dd></div>` : ""}
        </dl>
        <details>
          <summary>JSON データ</summary>
          <pre>${escapeHtml(JSON.stringify(feedbackForExport(item), null, 2))}</pre>
        </details>
        <button type="button" class="delete-feedback" data-delete-feedback data-feedback-id="${escapeHtml(item.id || "")}" title="このフィードバックを削除">削除</button>
        </details>
      </article>
    `;
    }

    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PatchLoop Inbox</title>
  <link rel="stylesheet" href="/static/inbox.css" />
</head>
<body>
  <a class="skip-link" href="#inbox">フィードバック一覧へ</a>
  <div class="app-shell">
  <aside class="sidebar" aria-label="受信箱のナビゲーション">
    <a class="brand" href="/">PatchLoop<span>FEEDBACK WORKSPACE</span></a>
    <p class="nav-label">受信箱</p>
    <nav class="status-nav" aria-label="対応状況で絞り込み">
      ${["", ...FEEDBACK_STATUSES].map((value) => `<button type="button" data-status-nav="${value}" aria-pressed="${value === ""}"><span>${STATUS_LABELS[value] || "すべて"}</span><span class="nav-count" data-status-count="${value}">${value ? items.filter((item) => feedbackStatusOf(item || {}) === value).length : items.length}</span></button>`).join("")}
    </nav>
    <div class="sidebar-footer"><p>気づきを、次の改善へ。</p><small>画面上のフィードバックを<br />確認して、修正につなげましょう。</small>
    ${RECEIVER_TOKEN ? '<form class="logout-form" method="post" action="/logout"><button type="submit">ログアウト</button></form>' : ""}</div>
  </aside>
  <main id="inbox" tabindex="-1">
  <header class="page-header">
    <div><p class="eyebrow">WORKSPACE / INBOX</p><h1>フィードバック</h1><p class="meta">画面の気づきを集めて、チームの次の一歩に。<span class="total"><span data-total-count>${items.length}</span> 件を受信</span></p></div>
    <a class="button secondary" href="/feedback.json" download>JSON を書き出す</a>
  </header>
  ${renderImportPanel(items.length === 0)}
  ${items.length === 0 ? "" : renderFilterPanel(items)}
  <p class="action-status" data-inbox-status role="status" aria-live="polite" hidden></p>
  <div class="feedback-stream">
  ${cards.join("")}
  </div>
  <p class="empty" data-inbox-empty${items.length === 0 ? "" : " hidden"}><strong>最初の気づきを集めましょう</strong><span>レビュー対象のページで PatchLoop を開き、場所を選んでコメントしてください。<br />保存したフィードバックの JSON ファイルも、上の「ファイルを読み込む」から取り込めます。</span></p>
  <p class="empty" data-filter-empty hidden><strong>一致するフィードバックがありません</strong><span>検索語や絞り込み条件を変えてみてください。</span><button type="button" data-filter-reset>絞り込みを解除</button></p>
  <noscript><p class="notice">検索・対応状況の変更・ファイルの読み込みには JavaScript を有効にしてください。</p></noscript>
  </main>
  </div>
  <script src="/static/inbox.js"></script>
</body>
</html>`;
  }

  function renderImportPanel(empty) {
    return `
  <details class="import-panel"${empty ? " open" : ""}>
    <summary>ファイルを読み込む<span>ダウンロードしたフィードバックを受信箱に追加</span></summary>
    <div>
      <p>PatchLoop で保存した .patchloop-feedback.json ファイルを選んでください。既存のフィードバックは重複して追加されません。</p>
    </div>
    <form class="import-form" data-import-form>
      <input type="file" accept=".json,application/json" data-import-file aria-label="インポートするフィードバックのJSONファイル" />
      <button type="submit">読み込む</button>
      <span class="import-status" data-import-status role="status" aria-live="polite" aria-atomic="true"></span>
      <button type="button" data-import-reload hidden>受信箱を更新</button>
    </form>
  </details>`;
  }

  function renderFilterPanel(items) {
    const optionList = (values, allLabel, labels = {}) => [`<option value="">${allLabel}</option>`]
      .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labels[value] || value)}</option>`))
      .join("");
    const unique = (mapper) => Array.from(new Set(items
      .filter((item) => item && typeof item === "object")
      .map(mapper).filter((value) => typeof value === "string" && value))).sort();
    const projects = unique((item) => item.projectId || "");
    const demos = unique((item) => item.demoId || "");
    const reviewers = unique((item) => item.reviewer || "");
    const sources = unique((item) => item.source || "receiver");
    const slackStatuses = unique((item) => (item.integrations && item.integrations.slack && item.integrations.slack.status) || "unknown");
    const githubStatuses = unique((item) => (item.integrations && item.integrations.github && item.integrations.github.status) || "none");

    return `
  <section class="filter-panel" data-filter-panel>
    <div class="primary-filters">
      <input type="search" placeholder="コメント、ページ、投稿者を検索…" data-filter-text aria-label="フィードバックを検索" />
      <select data-filter-key="project" aria-label="プロジェクトで絞り込み">${optionList(projects, "すべてのプロジェクト")}</select>
      <select data-filter-key="status" aria-label="ステータスで絞り込み">${optionList(FEEDBACK_STATUSES, "すべての状況", STATUS_LABELS)}</select>
    </div>
    <div class="filter-footer">
    <details class="advanced-filters"><summary>詳細な絞り込み</summary><div class="advanced-fields">
      <label>種類<select data-filter-key="kind" aria-label="指摘の種類で絞り込み">${optionList(["point", "area"], "すべて", KIND_LABELS)}</select></label>
      <label>デモ<select data-filter-key="demo" aria-label="デモで絞り込み">${optionList(demos, "すべて")}</select></label>
      <label>投稿者<select data-filter-key="reviewer" aria-label="投稿者で絞り込み">${optionList(reviewers, "すべて")}</select></label>
      <label>受信元<select data-filter-key="source" aria-label="受信元で絞り込み">${optionList(sources, "すべて")}</select></label>
      <label>Slack<select data-filter-key="slack" aria-label="Slack通知結果で絞り込み">${optionList(slackStatuses, "すべて")}</select></label>
      <label>GitHub<select data-filter-key="github" aria-label="GitHub Issueの作成状況で絞り込み">${optionList(githubStatuses, "すべて")}</select></label>
    </div></details>
    <button type="button" class="text-button" data-filter-reset>クリア</button>
    <span class="filter-count" data-filter-count role="status" aria-live="polite"></span>
    </div>
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

    if (!GITHUB_CONFIGURED) return '<span class="integration-note">GitHub 未接続</span>';

    const button = `<button type="button" class="github-create" data-github-create data-feedback-id="${escapeHtml(id || "")}">GitHub Issue を作成</button>`;
    if (github && github.status === "failed") {
      const code = github.statusCode ? ` (${escapeHtml(String(github.statusCode))})` : "";
      return `<span class="github-error">failed${code}: ${escapeHtml(github.error || "unknown error")}</span> ${button}`;
    }
    return button;
  }

  function renderScreenshotPreview(screenshot) {
    if (!screenshot) return "";
    if (screenshot.status === "saved" && typeof screenshot.fileName === "string" && screenshot.fileName) {
      const url = escapeHtml(`/screenshots/${encodeURIComponent(screenshot.fileName)}`);
      const size = screenshot.width && screenshot.height
        ? `${screenshot.width}×${screenshot.height}`
        : "";
      const bytes = screenshot.bytes ? `${screenshot.bytes} bytes` : "";
      const caption = [size, bytes].filter(Boolean).join(" · ");
      return `
        <figure class="screenshot">
          <a href="${url}" target="_blank" rel="noopener">
            <img src="${url}" alt="指摘箇所のスクリーンショット（新しいタブで拡大）" loading="lazy" decoding="async" />
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
  <link rel="stylesheet" href="/static/inbox.css" />
</head>
<body class="login-page">
  <main class="login-card">
  <a class="brand" href="/">PatchLoop<span>FEEDBACK WORKSPACE</span></a>
  <h1>おかえりなさい</h1>
  <p class="meta">アクセストークンを入力して、<br />チームのフィードバックを確認しましょう。</p>
  ${failed ? '<p class="error" id="login-error" role="alert">トークンが違います。確認してもう一度お試しください。</p>' : ""}
  <form method="post" action="/login">
    <label>アクセストークン
      <input type="password" name="token" autocomplete="current-password" autofocus required${failed ? ' aria-invalid="true" aria-describedby="login-error"' : ""} />
    </label>
    <button type="submit">受信箱を開く</button>
  </form>
  <p class="login-help">トークンが分からない場合は、<br />この受信箱を管理している方に確認してください。</p>
  </main>
</body>
</html>`;
  }

  return { renderInbox, renderLoginPage };
}

// Elements the screenshot cannot show that touch the selected spot (#148), as a
// note under the comment. The numbers match the dashed frames on the image.
function renderUncapturedNote(summary) {
  if (!summary || summary.state !== "detected" || summary.touching.length === 0) return "";
  const list = summary.touching
    .map((region) => `${region.number}. ${escapeHtml(region.tag)}（${escapeHtml(region.kindName)}・${UNCAPTURED_RELATION_LABELS[region.relation]}）`)
    .join("、");
  return `<p class="uncaptured-note">画像に写っていない要素が指摘箇所に重なっている可能性があります（番号は画像の点線の枠）: ${list}</p>`;
}

// One line for the details, telling "none" apart from "not checked".
function uncapturedSummaryText(summary) {
  if (summary.state === "detected") {
    const parts = [];
    if (summary.touching.length > 0) parts.push(`指摘箇所に ${summary.touching.length} 件`);
    if (summary.elsewhere > 0) parts.push(`${summary.touching.length > 0 ? "ほかに" : "指摘箇所の外に"} ${summary.elsewhere} 件`);
    if (summary.unlisted > 0) parts.push(`一覧にない ${summary.unlisted} 件（位置は不明）`);
    const text = parts.length > 0 ? parts.join("、") : "なし";
    return summary.scanTruncated ? `${text}（ページの走査は途中で打ち切り）` : text;
  }
  if (summary.state === "failed") return "検知に失敗";
  if (summary.state === "invalid") return "記録の形が不正なため破棄";
  if (summary.state === "unknown-version") return `この受信箱が知らない形式（version ${summary.version}）`;
  return "未確認（この確認より前の widget）";
}

module.exports = { createInboxView };
