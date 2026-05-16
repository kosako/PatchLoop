(function () {
  "use strict";

  const DEFAULTS = {
    projectId: "local-demo",
    demoId: "plain-html",
    endpoint: "",
    reviewer: "",
    position: "bottom-right",
    onSubmit: null
  };

  const state = {
    options: { ...DEFAULTS },
    active: false,
    pendingTarget: null,
    feedback: []
  };

  function init(options = {}) {
    state.options = { ...DEFAULTS, ...options };
    injectStyles();
    renderShell();
    bindGlobalCapture();
    return api;
  }

  function destroy() {
    document.removeEventListener("click", handleDocumentClick, true);
    document.querySelector("[data-patchloop-root]")?.remove();
    document.querySelectorAll("[data-patchloop-pin]").forEach((node) => node.remove());
    state.active = false;
    state.pendingTarget = null;
  }

  function renderShell() {
    document.querySelector("[data-patchloop-root]")?.remove();

    const root = document.createElement("div");
    root.dataset.patchloopRoot = "true";
    root.className = `pl-root pl-${state.options.position}`;
    root.innerHTML = `
      <button class="pl-launcher" type="button" data-pl-toggle aria-pressed="false" title="Toggle PatchLoop feedback mode">
        <span class="pl-dot"></span>
        <span>Feedback</span>
      </button>
      <section class="pl-panel" data-pl-panel hidden>
        <header>
          <strong>PatchLoop</strong>
          <button type="button" data-pl-close title="Close">x</button>
        </header>
        <p data-pl-help>Turn feedback mode on, then click the page.</p>
        <div class="pl-actions">
          <button type="button" data-pl-mode>Start comment mode</button>
          <button type="button" data-pl-clear>Clear pins</button>
        </div>
        <div class="pl-payload" data-pl-payload>No feedback yet.</div>
      </section>
      <form class="pl-comment" data-pl-comment hidden>
        <label>
          Comment
          <textarea data-pl-comment-text rows="4" placeholder="What should change here?"></textarea>
        </label>
        <label>
          Reviewer
          <input data-pl-reviewer value="${escapeHtml(state.options.reviewer)}" placeholder="Your name" />
        </label>
        <div class="pl-form-actions">
          <button type="button" data-pl-cancel>Cancel</button>
          <button type="submit">Submit</button>
        </div>
      </form>
    `;

    document.body.append(root);

    root.querySelector("[data-pl-toggle]").addEventListener("click", togglePanel);
    root.querySelector("[data-pl-close]").addEventListener("click", closePanel);
    root.querySelector("[data-pl-mode]").addEventListener("click", toggleFeedbackMode);
    root.querySelector("[data-pl-clear]").addEventListener("click", clearPins);
    root.querySelector("[data-pl-cancel]").addEventListener("click", closeCommentForm);
    root.querySelector("[data-pl-comment]").addEventListener("submit", submitComment);
  }

  function bindGlobalCapture() {
    document.removeEventListener("click", handleDocumentClick, true);
    document.addEventListener("click", handleDocumentClick, true);
  }

  function handleDocumentClick(event) {
    if (!state.active) return;
    if (event.target.closest("[data-patchloop-root]")) return;

    event.preventDefault();
    event.stopPropagation();

    const target = event.target;
    const point = pointFromEvent(event);
    state.pendingTarget = {
      ...point,
      selector: selectorFor(target),
      elementText: textFor(target)
    };

    addPin(point);
    openCommentForm(point);
  }

  function togglePanel() {
    const panel = getRoot().querySelector("[data-pl-panel]");
    panel.hidden = !panel.hidden;
  }

  function closePanel() {
    getRoot().querySelector("[data-pl-panel]").hidden = true;
  }

  function toggleFeedbackMode() {
    setFeedbackMode(!state.active);
  }

  function setFeedbackMode(nextValue) {
    state.active = nextValue;
    document.documentElement.classList.toggle("pl-feedback-active", state.active);
    const root = getRoot();
    root.querySelector("[data-pl-toggle]").setAttribute("aria-pressed", String(state.active));
    root.querySelector("[data-pl-mode]").textContent = state.active ? "Stop comment mode" : "Start comment mode";
    root.querySelector("[data-pl-help]").textContent = state.active ? "Click the exact place that needs feedback." : "Turn feedback mode on, then click the page.";
  }

  function openCommentForm(point) {
    const form = getRoot().querySelector("[data-pl-comment]");
    form.hidden = false;
    form.style.left = `${Math.min(point.clientX + 14, window.innerWidth - 340)}px`;
    form.style.top = `${Math.min(point.clientY + 14, window.innerHeight - 250)}px`;
    form.querySelector("[data-pl-comment-text]").value = "";
    form.querySelector("[data-pl-comment-text]").focus();
  }

  function closeCommentForm() {
    getRoot().querySelector("[data-pl-comment]").hidden = true;
    state.pendingTarget = null;
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!state.pendingTarget) return;

    const root = getRoot();
    const comment = root.querySelector("[data-pl-comment-text]").value.trim();
    const reviewer = root.querySelector("[data-pl-reviewer]").value.trim();
    if (!comment) return;

    const payload = buildPayload(comment, reviewer, state.pendingTarget);
    state.feedback.unshift(payload);
    showPayload(payload);
    closeCommentForm();
    setFeedbackMode(false);

    document.dispatchEvent(new CustomEvent("patchloop:feedback", { detail: payload }));

    if (typeof state.options.onSubmit === "function") {
      state.options.onSubmit(payload);
    }

    if (state.options.endpoint) {
      await postFeedback(payload);
    }
  }

  function buildPayload(comment, reviewer, target) {
    return {
      id: `pl_${Date.now()}`,
      projectId: state.options.projectId,
      demoId: state.options.demoId,
      comment,
      reviewer,
      page: {
        url: window.location.href,
        title: document.title
      },
      target: {
        x: round(target.x),
        y: round(target.y),
        clientX: Math.round(target.clientX),
        clientY: Math.round(target.clientY),
        selector: target.selector,
        text: target.elementText
      },
      environment: {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        browser: navigator.userAgent,
        language: navigator.language
      },
      createdAt: new Date().toISOString()
    };
  }

  async function postFeedback(payload) {
    try {
      const response = await fetch(state.options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      payload.delivery = { ok: response.ok, status: response.status };
    } catch (error) {
      payload.delivery = { ok: false, error: error.message };
    }
    showPayload(payload);
  }

  function showPayload(payload) {
    const output = getRoot().querySelector("[data-pl-payload]");
    output.textContent = JSON.stringify(payload, null, 2);
    getRoot().querySelector("[data-pl-panel]").hidden = false;
    console.info("[PatchLoop] feedback payload", payload);
  }

  function addPin(point) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.dataset.patchloopPin = "true";
    pin.className = "pl-pin";
    pin.style.left = `${point.clientX}px`;
    pin.style.top = `${point.clientY}px`;
    pin.textContent = String(state.feedback.length + 1);
    document.body.append(pin);
  }

  function clearPins() {
    document.querySelectorAll("[data-patchloop-pin]").forEach((node) => node.remove());
    state.feedback = [];
    getRoot().querySelector("[data-pl-payload]").textContent = "No feedback yet.";
  }

  function pointFromEvent(event) {
    return {
      x: (event.clientX / Math.max(document.documentElement.clientWidth, 1)) * 100,
      y: (event.clientY / Math.max(document.documentElement.clientHeight, 1)) * 100,
      clientX: event.clientX,
      clientY: event.clientY
    };
  }

  function selectorFor(element) {
    if (!element || element === document.body) return "body";
    if (element.id) return `#${cssEscape(element.id)}`;

    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || []).slice(0, 2);
      if (classes.length) part += `.${classes.map(cssEscape).join(".")}`;
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }

  function textFor(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140);
  }

  function getRoot() {
    return document.querySelector("[data-patchloop-root]");
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function injectStyles() {
    if (document.querySelector("[data-patchloop-style]")) return;
    const style = document.createElement("style");
    style.dataset.patchloopStyle = "true";
    style.textContent = `
      .pl-root, .pl-root * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .pl-root { position: fixed; z-index: 2147483000; color: #14211d; }
      .pl-bottom-right { right: 20px; bottom: 20px; }
      .pl-launcher { min-height: 42px; border: 1px solid #0f7b63; border-radius: 999px; padding: 0 16px; display: inline-flex; align-items: center; gap: 8px; background: #0f7b63; color: #fff; font-weight: 800; box-shadow: 0 16px 40px rgba(20, 33, 29, 0.18); cursor: pointer; }
      .pl-launcher[aria-pressed="true"] { background: #d1495b; border-color: #d1495b; }
      .pl-dot { width: 9px; height: 9px; border-radius: 50%; background: currentColor; opacity: 0.85; }
      .pl-panel { position: absolute; right: 0; bottom: 54px; width: min(390px, calc(100vw - 32px)); background: #fff; border: 1px solid #d9e1dd; border-radius: 8px; box-shadow: 0 22px 70px rgba(20, 33, 29, 0.22); overflow: hidden; }
      .pl-panel header { min-height: 48px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #d9e1dd; }
      .pl-panel header button { width: 32px; height: 32px; border: 0; background: transparent; cursor: pointer; font-size: 18px; }
      .pl-panel p { margin: 0; padding: 14px; color: #65716d; font-size: 13px; }
      .pl-actions { display: flex; gap: 8px; padding: 0 14px 14px; }
      .pl-actions button, .pl-form-actions button { min-height: 36px; border-radius: 8px; border: 1px solid #d9e1dd; background: #fff; color: #14211d; padding: 0 12px; cursor: pointer; }
      .pl-actions button:first-child, .pl-form-actions button[type="submit"] { background: #0f7b63; border-color: #0f7b63; color: #fff; font-weight: 800; }
      .pl-payload { max-height: 260px; overflow: auto; margin: 0 14px 14px; padding: 12px; border: 1px solid #d9e1dd; border-radius: 8px; background: #f7f8f5; color: #24312d; white-space: pre-wrap; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .pl-comment { position: fixed; z-index: 2147483001; width: min(320px, calc(100vw - 24px)); display: grid; gap: 10px; padding: 14px; background: #fff; border: 1px solid #d9e1dd; border-radius: 8px; box-shadow: 0 22px 70px rgba(20, 33, 29, 0.24); }
      .pl-comment label { display: grid; gap: 6px; color: #65716d; font-size: 12px; font-weight: 800; }
      .pl-comment textarea, .pl-comment input { width: 100%; border: 1px solid #d9e1dd; border-radius: 8px; padding: 9px 10px; color: #14211d; font: inherit; resize: vertical; }
      .pl-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .pl-pin { position: fixed; z-index: 2147482999; transform: translate(-50%, -50%); width: 30px; height: 30px; border-radius: 50%; border: 3px solid #fff; background: #d1495b; color: #fff; font-weight: 900; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); pointer-events: none; }
      .pl-feedback-active, .pl-feedback-active * { cursor: crosshair !important; }
    `;
    document.head.append(style);
  }

  const api = {
    init,
    destroy,
    setFeedbackMode,
    getFeedback: () => [...state.feedback]
  };

  window.PatchLoop = api;
})();
