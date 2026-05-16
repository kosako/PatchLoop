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
    drag: null,
    suppressNextClick: false,
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
    document.removeEventListener("mousedown", handleDocumentMouseDown, true);
    document.removeEventListener("mousemove", handleDocumentMouseMove, true);
    document.removeEventListener("mouseup", handleDocumentMouseUp, true);
    document.removeEventListener("click", suppressDocumentClick, true);
    document.querySelector("[data-patchloop-root]")?.remove();
    document.querySelectorAll("[data-patchloop-pin]").forEach((node) => node.remove());
    document.querySelectorAll("[data-patchloop-area]").forEach((node) => node.remove());
    removeSelectionBox();
    state.active = false;
    state.pendingTarget = null;
    state.drag = null;
  }

  function renderShell() {
    document.querySelector("[data-patchloop-root]")?.remove();

    const root = document.createElement("div");
    root.dataset.patchloopRoot = "true";
    root.className = `pl-root pl-${state.options.position}`;
    root.innerHTML = `
      <button class="pl-launcher" type="button" data-pl-toggle aria-pressed="false" title="Toggle PatchLoop feedback mode">
        <span class="pl-dot"></span>
        <span>フィードバック</span>
      </button>
      <section class="pl-panel" data-pl-panel hidden>
        <header>
          <strong>PatchLoop</strong>
          <button type="button" data-pl-close title="閉じる">x</button>
        </header>
        <p data-pl-help>コメントモードを開始して、画面上の気になる場所をクリックしてください。</p>
        <div class="pl-actions">
          <button type="button" data-pl-mode>コメントモード開始</button>
          <button type="button" data-pl-clear>ピンを消す</button>
        </div>
        <div class="pl-payload" data-pl-payload>まだフィードバックはありません。</div>
      </section>
      <form class="pl-comment" data-pl-comment hidden>
        <label>
          コメント
          <textarea data-pl-comment-text rows="4" placeholder="ここで何を直したいですか？"></textarea>
        </label>
        <label>
          投稿者
          <input data-pl-reviewer value="${escapeHtml(state.options.reviewer)}" placeholder="名前" />
        </label>
        <div class="pl-form-actions">
          <button type="button" data-pl-cancel>キャンセル</button>
          <button type="submit">送信</button>
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
    document.removeEventListener("mousedown", handleDocumentMouseDown, true);
    document.removeEventListener("mousemove", handleDocumentMouseMove, true);
    document.removeEventListener("mouseup", handleDocumentMouseUp, true);
    document.removeEventListener("click", suppressDocumentClick, true);
    document.addEventListener("mousedown", handleDocumentMouseDown, true);
    document.addEventListener("mousemove", handleDocumentMouseMove, true);
    document.addEventListener("mouseup", handleDocumentMouseUp, true);
    document.addEventListener("click", suppressDocumentClick, true);
  }

  function handleDocumentMouseDown(event) {
    if (!state.active) return;
    if (event.target.closest("[data-patchloop-root]")) return;

    event.preventDefault();
    event.stopPropagation();

    state.drag = {
      startedAt: pointFromEvent(event),
      latest: pointFromEvent(event),
      target: event.target,
      isDragging: false
    };
    state.suppressNextClick = true;
  }

  function handleDocumentMouseMove(event) {
    if (!state.active || !state.drag) return;
    if (event.target.closest("[data-patchloop-root]")) return;

    event.preventDefault();
    event.stopPropagation();

    state.drag.latest = pointFromEvent(event);
    const rect = rectFromPoints(state.drag.startedAt, state.drag.latest);
    state.drag.isDragging = rect.widthPx > 8 || rect.heightPx > 8;

    if (state.drag.isDragging) {
      renderSelectionBox(rect);
    }
  }

  function handleDocumentMouseUp(event) {
    if (!state.active || !state.drag) return;
    if (event.target.closest("[data-patchloop-root]")) return;

    event.preventDefault();
    event.stopPropagation();

    const start = state.drag.startedAt;
    const end = pointFromEvent(event);
    const rect = rectFromPoints(start, end);
    const target = document.elementFromPoint(start.clientX, start.clientY) || state.drag.target;

    if (state.drag.isDragging) {
      state.pendingTarget = {
        kind: "area",
        ...pointFromClient(rect.leftPx, rect.topPx),
        area: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
          clientX: Math.round(rect.leftPx),
          clientY: Math.round(rect.topPx),
          clientWidth: Math.round(rect.widthPx),
          clientHeight: Math.round(rect.heightPx)
        },
        selector: selectorFor(target),
        elementText: textFor(target)
      };
      addArea(rect);
      openCommentForm({ clientX: rect.rightPx, clientY: rect.bottomPx });
    } else {
      const point = pointFromEvent(event);
      state.pendingTarget = {
        kind: "point",
        ...point,
        selector: selectorFor(target),
        elementText: textFor(target)
      };
      addPin(point);
      openCommentForm(point);
    }

    removeSelectionBox();
    state.drag = null;
  }

  function suppressDocumentClick(event) {
    if (!state.suppressNextClick) return;
    state.suppressNextClick = false;
    if (event.target.closest("[data-patchloop-root]")) return;
    event.preventDefault();
    event.stopPropagation();
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
    root.querySelector("[data-pl-mode]").textContent = state.active ? "コメントモード終了" : "コメントモード開始";
    root.querySelector("[data-pl-help]").textContent = state.active ? "点をクリック、または範囲をドラッグしてコメントできます。" : "コメントモードを開始して、画面上の気になる場所をクリックしてください。";
    if (!state.active) {
      removeSelectionBox();
      state.drag = null;
    }
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
        kind: target.kind || "point",
        x: round(target.x),
        y: round(target.y),
        clientX: Math.round(target.clientX),
        clientY: Math.round(target.clientY),
        area: target.area || null,
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
    document.querySelectorAll("[data-patchloop-area]").forEach((node) => node.remove());
    removeSelectionBox();
    state.feedback = [];
    getRoot().querySelector("[data-pl-payload]").textContent = "まだフィードバックはありません。";
  }

  function pointFromEvent(event) {
    return pointFromClient(event.clientX, event.clientY);
  }

  function pointFromClient(clientX, clientY) {
    return {
      x: (clientX / Math.max(document.documentElement.clientWidth, 1)) * 100,
      y: (clientY / Math.max(document.documentElement.clientHeight, 1)) * 100,
      clientX,
      clientY
    };
  }

  function rectFromPoints(start, end) {
    const leftPx = Math.min(start.clientX, end.clientX);
    const topPx = Math.min(start.clientY, end.clientY);
    const rightPx = Math.max(start.clientX, end.clientX);
    const bottomPx = Math.max(start.clientY, end.clientY);
    const viewportWidth = Math.max(document.documentElement.clientWidth, 1);
    const viewportHeight = Math.max(document.documentElement.clientHeight, 1);

    return {
      leftPx,
      topPx,
      rightPx,
      bottomPx,
      widthPx: rightPx - leftPx,
      heightPx: bottomPx - topPx,
      x: (leftPx / viewportWidth) * 100,
      y: (topPx / viewportHeight) * 100,
      width: ((rightPx - leftPx) / viewportWidth) * 100,
      height: ((bottomPx - topPx) / viewportHeight) * 100
    };
  }

  function renderSelectionBox(rect) {
    let box = document.querySelector("[data-patchloop-selection]");
    if (!box) {
      box = document.createElement("div");
      box.dataset.patchloopSelection = "true";
      box.className = "pl-selection";
      document.body.append(box);
    }
    Object.assign(box.style, {
      left: `${rect.leftPx}px`,
      top: `${rect.topPx}px`,
      width: `${rect.widthPx}px`,
      height: `${rect.heightPx}px`
    });
  }

  function removeSelectionBox() {
    document.querySelector("[data-patchloop-selection]")?.remove();
  }

  function addArea(rect) {
    const area = document.createElement("div");
    area.dataset.patchloopArea = "true";
    area.className = "pl-area";
    Object.assign(area.style, {
      left: `${rect.leftPx}px`,
      top: `${rect.topPx}px`,
      width: `${rect.widthPx}px`,
      height: `${rect.heightPx}px`
    });
    area.innerHTML = `<span>${state.feedback.length + 1}</span>`;
    document.body.append(area);
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
      .pl-root [hidden], .pl-comment[hidden], .pl-panel[hidden] { display: none !important; }
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
      .pl-selection, .pl-area { position: fixed; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; }
      .pl-area { box-shadow: 0 12px 30px rgba(20, 33, 29, 0.16); }
      .pl-area span { position: absolute; top: -15px; left: -15px; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; border: 3px solid #fff; background: #d1495b; color: #fff; font-weight: 900; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); }
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
