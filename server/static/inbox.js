"use strict";

// All request feedback stays in the current view, so a failed operation never
// clears search/filter state or hides the result behind an automatic reload.
function showInboxMessage(message, { error = false, card = null } = {}) {
  const target = card?.querySelector("[data-action-status]") || document.querySelector("[data-inbox-status]");
  if (!target) return;
  target.textContent = message;
  target.dataset.state = error ? "error" : "success";
  target.hidden = false;
}

async function inboxRequest(url, options) {
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error("ログインの有効期限が切れています。ページを再読み込みしてログインしてください。");
  if (response.status === 429) throw new Error("リクエストが集中しています。しばらく待って、もう一度お試しください。");
  return { response, result };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

const byteLength = (text) => new TextEncoder().encode(text).length;

// The import requests for a file (#140): the file as it is when it fits the
// receiver's request limit (or cannot be split), otherwise parts holding as
// many comments as fit in maxBytes and maxItems. The receiver inserts each
// request's comments oldest first (#156), so parts are cut from the comments
// in that order, oldest part first, and each part lists its comments in the
// file's order as the receiver expects: the inbox ends up as one request
// would leave it. Returns [{ body, count, oversized }]: count is the number of
// comments in the part (null when unknown), oversized whether it still exceeds
// maxBytes (a single comment that large cannot be split).
function importParts(text, maxBytes, maxItems) {
  const oversized = Boolean(maxBytes) && byteLength(text) > maxBytes;
  if (!oversized) return [{ body: text, count: null, oversized }];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return [{ body: text, count: null, oversized }];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.feedback) ? parsed.feedback : null;
  if (!list || list.length < 2) return [{ body: text, count: list ? list.length : 1, oversized }];
  const wrap = Array.isArray(parsed) ? (items) => items : (items) => ({ ...parsed, feedback: items });

  const created = (item) => Date.parse(item?.createdAt);
  const ordered = list.slice().reverse().sort((a, b) => {
    const aUnknown = Number.isNaN(created(a));
    const bUnknown = Number.isNaN(created(b));
    if (aUnknown !== bUnknown) return aUnknown ? -1 : 1;
    return aUnknown ? 0 : created(a) - created(b);
  });
  // Serialized without spaces, a part is the wrapper plus its comments joined by commas.
  const overhead = byteLength(JSON.stringify(wrap([])));
  const parts = [];
  let current = [];
  let size = overhead;
  for (const item of ordered) {
    const itemSize = byteLength(JSON.stringify(item));
    const grown = size + itemSize + (current.length ? 1 : 0);
    if (current.length && (grown > maxBytes || (maxItems && current.length >= maxItems))) {
      parts.push(current);
      current = [];
      size = overhead;
    }
    size += itemSize + (current.length ? 1 : 0);
    current.push(item);
  }
  parts.push(current);
  return parts.map((items) => {
    const body = JSON.stringify(wrap(items.slice().reverse()));
    return { body, count: items.length, oversized: byteLength(body) > maxBytes };
  });
}

(() => {
  const form = document.querySelector("[data-import-form]");
  if (!form) return;
  const input = form.querySelector("[data-import-file]");
  const status = form.querySelector("[data-import-status]");
  const submit = form.querySelector('button[type="submit"]');
  const reload = form.querySelector("[data-import-reload]");
  let importing = false;
  reload?.addEventListener("click", () => window.location.reload());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (importing) return;
    status.dataset.state = "";
    const file = input.files && input.files[0];
    if (!file) {
      status.dataset.state = "error";
      status.textContent = "読み込む JSON ファイルを選んでください。";
      input.focus();
      return;
    }

    importing = true;
    if (submit) submit.disabled = true;
    input.disabled = true;
    status.textContent = "ファイルを読み込んでいます…";
    let imported = 0;
    try {
      const maxBytes = positiveInteger(form.dataset.maxBodyBytes);
      const parts = importParts(await file.text(), maxBytes, positiveInteger(form.dataset.maxImportItems));
      let skipped = 0;
      const failed = [];
      for (const [index, part] of parts.entries()) {
        if (parts.length > 1) status.textContent = "ファイルを分けて読み込んでいます…（" + (index + 1) + " / " + parts.length + "）";
        const { response, result } = await inboxRequest("/import", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: part.body
        });
        // A 409 all-duplicates response still contains a batch summary.
        if (result.imported !== undefined) {
          imported += result.imported || 0;
          skipped += result.duplicates?.length || 0;
          failed.push(...(result.failed || []));
        } else if (!response.ok) {
          const error = response.status === 413 && part.oversized
            ? (part.count === 1 ? "コメント 1 件で" : "ファイルが分けられず、") + "受信側の上限（" + maxBytes + " byte）を超えています。"
              + "receiver の MAX_BODY_BYTES（設定の maxBodyBytes）を上げると読み込めます。"
            : result.error || "ファイルを読み込めませんでした。";
          // A file sent whole keeps its error as the message, as before #140.
          if (parts.length === 1) throw new Error(error);
          // The receiver took none of the part: count each comment, with the reason as said.
          for (let item = 0; item < part.count; item += 1) failed.push({ status: response.status, message: error });
        }
      }
      const failureMessage = failed.length ? (failed.every((item) => item.status === 507)
        ? "受信側の保存容量の上限に達しました。receiver の設定で上限を変更できます。"
        : failed[0].message || "受信側で保存に失敗しました。" + failed[0].error) : "";
      status.dataset.state = failed.length ? "error" : "success";
      status.textContent = imported + " 件を追加しました。"
        + (skipped ? "重複 " + skipped + " 件はスキップしました。" : "")
        + (failed.length ? "失敗 " + failed.length + " 件。" + failureMessage : "")
        + (imported ? "「受信箱を更新」で一覧に反映します。" : "");
    } catch (error) {
      status.dataset.state = "error";
      // Parts already sent stay imported; importing the file again skips them.
      status.textContent = imported
        ? imported + " 件を追加したところで止まりました。" + error.message + "もう一度読み込むと、追加済みのものは重複としてスキップされます。"
        : error.message;
    } finally {
      if (reload && imported) reload.hidden = false;
      importing = false;
      if (submit) submit.disabled = false;
      input.disabled = false;
    }
  });
})();

(() => {
  const panel = document.querySelector("[data-filter-panel]");
  const textInput = panel?.querySelector("[data-filter-text]");
  const selects = panel ? Array.from(panel.querySelectorAll("[data-filter-key]")) : [];
  const statusFilter = selects.find((select) => select.dataset.filterKey === "status");
  const count = panel?.querySelector("[data-filter-count]");
  const totalCount = document.querySelector("[data-total-count]");
  const emptyNote = document.querySelector("[data-filter-empty]");
  const inboxEmpty = document.querySelector("[data-inbox-empty]");
  const statusButtons = Array.from(document.querySelectorAll("[data-status-nav]"));

  const applyFilters = () => {
    const cards = Array.from(document.querySelectorAll("[data-card]"));
    const text = textInput ? textInput.value.trim().toLowerCase() : "";
    let visible = 0;
    cards.forEach((card) => {
      const matchesText = !text || card.dataset.search.includes(text);
      const matchesSelects = selects.every((select) => !select.value || card.dataset[select.dataset.filterKey] === select.value);
      card.hidden = !(matchesText && matchesSelects);
      if (!card.hidden) visible += 1;
    });
    if (count) count.textContent = visible === cards.length ? cards.length + " 件" : visible + " / " + cards.length + " 件";
    if (totalCount) totalCount.textContent = String(cards.length);
    if (emptyNote) emptyNote.hidden = cards.length === 0 || visible > 0;
    if (inboxEmpty) inboxEmpty.hidden = cards.length > 0;
    if (panel) panel.hidden = cards.length === 0;
    statusButtons.forEach((button) => {
      const value = button.dataset.statusNav;
      button.setAttribute("aria-pressed", String(value === (statusFilter?.value || "")));
      const badge = button.querySelector("[data-status-count]");
      if (badge) badge.textContent = String(value ? cards.filter((card) => card.dataset.status === value).length : cards.length);
    });
  };

  textInput?.addEventListener("input", applyFilters);
  selects.forEach((select) => select.addEventListener("change", applyFilters));
  statusButtons.forEach((button) => button.addEventListener("click", () => {
    if (statusFilter) statusFilter.value = button.dataset.statusNav;
    applyFilters();
  }));
  document.querySelectorAll("[data-filter-reset]").forEach((button) => button.addEventListener("click", () => {
    if (textInput) textInput.value = "";
    selects.forEach((select) => { select.value = ""; });
    applyFilters();
    textInput?.focus();
  }));
  applyFilters();

  document.querySelectorAll("[data-github-create]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const card = button.closest("[data-card]");
      const cell = button.closest("[data-github-cell]");
      button.disabled = true;
      button.textContent = "作成中…";
      try {
        const { response, result } = await inboxRequest("/feedback/" + encodeURIComponent(button.dataset.feedbackId) + "/github-issue", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
        });
        const existing = response.status === 409 && result.github?.issueNumber;
        if (!response.ok && !existing) throw new Error(result.error || "GitHub Issue を作成できませんでした。");
        card.dataset.github = "created";
        let url;
        try { url = new URL(result.github?.url); } catch { /* Show a recovery message below. */ }
        // Once the issue exists, a failure the server rendered for an earlier
        // attempt is stale, so the cell keeps only the created issue.
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
          button.textContent = "Issue 作成済み";
          cell.replaceChildren(button);
          applyFilters();
          showInboxMessage("Issue は作成されています。ページを更新して確認してください。", { card: card.hidden ? null : card });
          textInput?.focus();
          return;
        }
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener";
        // Matches the link the server renders for a created issue.
        link.textContent = (result.github.issueNumber != null ? "#" + result.github.issueNumber : "issue") + " created";
        cell.replaceChildren(link);
        applyFilters();
        showInboxMessage(existing ? "作成済みの GitHub Issue を表示しました。" : "GitHub Issue を作成しました。", { card: card.hidden ? null : card });
        if (card.hidden) textInput?.focus();
        else link.focus();
      } catch (error) {
        button.disabled = false;
        button.textContent = "GitHub Issue を作成";
        showInboxMessage(error.message, { error: true, card });
      }
    });
  });

  document.querySelectorAll("[data-status-select]").forEach((select) => {
    select.addEventListener("change", async () => {
      const card = select.closest("[data-card]");
      const previous = card.dataset.status;
      select.disabled = true;
      try {
        const { response, result } = await inboxRequest("/feedback/" + encodeURIComponent(select.dataset.feedbackId) + "/status", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: select.value })
        });
        if (!response.ok) throw new Error(result.error || "対応状況を更新できませんでした。");
        card.dataset.status = select.value;
        applyFilters();
        showInboxMessage("対応状況を更新しました。", { card: card.hidden ? null : card });
        if (card.hidden) textInput?.focus();
      } catch (error) {
        select.value = previous;
        showInboxMessage(error.message, { error: true, card });
      } finally {
        select.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-delete-feedback]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      if (!window.confirm("このフィードバックと保存画像を削除します。元に戻せません。削除しますか？")) return;
      const card = button.closest("[data-card]");
      button.disabled = true;
      button.textContent = "削除中…";
      try {
        const { response, result } = await inboxRequest("/feedback/" + encodeURIComponent(button.dataset.feedbackId), { method: "DELETE" });
        if (!response.ok) throw new Error(result.error || "削除できませんでした。");
        card.remove();
        applyFilters();
        showInboxMessage("フィードバックを削除しました。");
        if (panel && !panel.hidden) textInput?.focus();
        else document.querySelector("#inbox")?.focus();
      } catch (error) {
        button.disabled = false;
        button.textContent = "削除";
        showInboxMessage(error.message, { error: true, card });
      }
    });
  });
})();
