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
    try {
      const text = await file.text();
      const { response, result } = await inboxRequest("/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: text
      });
      // A 409 all-duplicates response still contains a batch summary.
      if (!response.ok && result.imported === undefined) throw new Error(result.error || "ファイルを読み込めませんでした。");
      const imported = result.imported || 0;
      const skipped = result.duplicates?.length || 0;
      const failed = result.failed?.length || 0;
      status.dataset.state = failed ? "error" : "success";
      status.textContent = imported + " 件を追加しました。"
        + (skipped ? "重複 " + skipped + " 件はスキップしました。" : "")
        + (failed ? "失敗 " + failed + " 件。ファイルを確認して再試行してください。" : "")
        + (imported ? "「受信箱を更新」で一覧に反映します。" : "");
      if (reload && imported) reload.hidden = false;
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error.message;
    } finally {
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
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
          button.textContent = "Issue 作成済み";
          applyFilters();
          showInboxMessage("Issue は作成されています。ページを更新して確認してください。", { card: card.hidden ? null : card });
          textInput?.focus();
          return;
        }
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Issue #" + result.github.issueNumber;
        button.replaceWith(link);
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
