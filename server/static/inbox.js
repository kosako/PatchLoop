"use strict";

// Inbox client behavior, split from the server-rendered HTML (issue #62).
// Bundle import panel first, then triage (same order the inline scripts had).

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

  document.querySelectorAll("[data-github-create]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Creating...";
      try {
        const response = await fetch("/feedback/" + encodeURIComponent(button.dataset.feedbackId) + "/github-issue", { method: "POST" });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "GitHub issue creation failed");
      } catch (error) {
        window.alert(error.message);
      }
      window.location.reload();
    });
  });

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
