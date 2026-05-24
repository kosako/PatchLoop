(function () {
  "use strict";

  const DEFAULTS = {
    projectId: "local-demo",
    demoId: "plain-html",
    endpoint: "",
    deliveryMode: "receiver",
    slackWebhookUrl: "",
    showDeliverySettings: false,
    reviewer: "",
    position: "bottom-right",
    captureScreenshot: true,
    screenshotMaxBytes: 1_200_000,
    onSubmit: null
  };

  const state = {
    options: { ...DEFAULTS },
    active: false,
    pendingTarget: null,
    drag: null,
    suppressNextClick: false,
    feedback: [],
    feedbackMarkers: new Map(),
    editingId: null,
    collapsed: true
  };

  function init(options = {}) {
    state.options = { ...DEFAULTS, ...options };
    injectStyles();
    renderShell();
    bindGlobalCapture();
    applyCollapseState();
    renderFeedbackList();
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
    document.querySelectorAll(".pl-target-highlight").forEach((node) => node.classList.remove("pl-target-highlight"));
    removeSelectionBox();
    state.active = false;
    state.pendingTarget = null;
    state.drag = null;
    state.feedbackMarkers.clear();
    state.editingId = null;
  }

  function renderShell() {
    document.querySelector("[data-patchloop-root]")?.remove();

    const root = document.createElement("div");
    root.dataset.patchloopRoot = "true";
    root.className = `pl-root pl-${state.options.position}`;
    root.innerHTML = `
      <section class="pl-panel pl-collapsed" data-pl-panel>
        <header>
          <button type="button" class="pl-handle" data-pl-collapse aria-expanded="false" title="展開">‹</button>
          <strong class="pl-title">PatchLoop</strong>
          <button type="button" class="pl-mode" data-pl-mode>コメントモード開始</button>
        </header>
        <div class="pl-panel-body" data-pl-body>
          <p data-pl-help>コメントモードを開始して、画面上の気になる場所をクリックしてください。</p>
          <div class="pl-actions">
            <button type="button" data-pl-clear>ピンを消す</button>
          </div>
          ${renderDeliverySettings()}
          <div class="pl-feedback-list" data-pl-list>
            <p class="pl-feedback-list-empty">まだフィードバックはありません。</p>
          </div>
        </div>
      </section>
      <div class="pl-tooltip" data-pl-tooltip hidden></div>
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

    root.querySelector("[data-pl-collapse]").addEventListener("click", toggleCollapse);
    root.querySelector("[data-pl-mode]").addEventListener("click", toggleFeedbackMode);
    root.querySelector("[data-pl-clear]").addEventListener("click", clearPins);
    root.querySelector("[data-pl-cancel]").addEventListener("click", cancelPendingComment);
    root.querySelector("[data-pl-comment]").addEventListener("submit", submitComment);
    root.querySelector("[data-pl-list]").addEventListener("click", handleListClick);
    root.querySelector("[data-pl-delivery-settings]")?.addEventListener("input", handleDeliverySettingsInput);
    root.querySelector("[data-pl-delivery-settings]")?.addEventListener("change", handleDeliverySettingsInput);
    syncDeliverySettingsVisibility();
  }

  function renderDeliverySettings() {
    if (!state.options.showDeliverySettings) return "";

    return `
          <details class="pl-delivery-settings" data-pl-delivery-settings>
            <summary>送信設定</summary>
            <label>
              送信先
              <select data-pl-delivery-mode>
                <option value="receiver"${state.options.deliveryMode === "receiver" ? " selected" : ""}>Receiver</option>
                <option value="slack-webhook"${state.options.deliveryMode === "slack-webhook" ? " selected" : ""}>Slack direct</option>
                <option value="none"${state.options.deliveryMode === "none" ? " selected" : ""}>送信なし</option>
              </select>
            </label>
            <label data-pl-endpoint-field>
              Receiver endpoint
              <input data-pl-endpoint value="${escapeHtml(state.options.endpoint)}" placeholder="http://localhost:4000/feedback" />
            </label>
            <label data-pl-slack-field>
              Slack webhook URL
              <input type="password" data-pl-slack-webhook value="${escapeHtml(state.options.slackWebhookUrl)}" placeholder="https://hooks.slack.com/services/..." />
            </label>
          </details>
    `;
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

    discardPendingMarker();

    let marker;
    if (state.drag.isDragging) {
      marker = addArea(rect);
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
          clientHeight: Math.round(rect.heightPx),
          pageX: Math.round(rect.pageLeftPx),
          pageY: Math.round(rect.pageTopPx),
          documentX: round(rect.documentX),
          documentY: round(rect.documentY),
          documentWidth: round(rect.documentWidth),
          documentHeight: round(rect.documentHeight)
        },
        selector: selectorFor(target),
        elementText: textFor(target),
        markerNode: marker.node,
        markerLabelNode: marker.label,
        targetElement: target
      };
      openCommentForm({ clientX: rect.rightPx, clientY: rect.bottomPx });
    } else {
      const point = pointFromEvent(event);
      marker = addPin(point);
      state.pendingTarget = {
        kind: "point",
        ...point,
        selector: selectorFor(target),
        elementText: textFor(target),
        markerNode: marker.node,
        markerLabelNode: marker.label,
        targetElement: target
      };
      openCommentForm(point);
    }

    highlightTarget(target);

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

  function toggleFeedbackMode() {
    setFeedbackMode(!state.active);
  }

  function setFeedbackMode(nextValue) {
    state.active = nextValue;
    document.documentElement.classList.toggle("pl-feedback-active", state.active);
    const root = getRoot();
    const handleBtn = root.querySelector("[data-pl-collapse]");
    if (handleBtn) handleBtn.classList.toggle("pl-mode-on", state.active);
    const modeBtn = root.querySelector("[data-pl-mode]");
    modeBtn.textContent = state.active ? "コメントモード終了" : "コメントモード開始";
    modeBtn.setAttribute("aria-pressed", String(state.active));
    root.querySelector("[data-pl-help]").textContent = state.active ? "点をクリック、または範囲をドラッグしてコメントできます。" : "コメントモードを開始して、画面上の気になる場所をクリックしてください。";
    if (!state.active) {
      removeSelectionBox();
      state.drag = null;
    }
  }

  function openCommentForm(point, options = {}) {
    const form = getRoot().querySelector("[data-pl-comment]");
    form.hidden = false;
    form.style.left = `${Math.min(point.clientX + 14, window.innerWidth - 340)}px`;
    form.style.top = `${Math.min(point.clientY + 14, window.innerHeight - 250)}px`;
    const commentEl = form.querySelector("[data-pl-comment-text]");
    const reviewerEl = form.querySelector("[data-pl-reviewer]");
    commentEl.value = options.comment != null ? options.comment : "";
    if (options.reviewer != null) {
      reviewerEl.value = options.reviewer;
    }
    commentEl.focus();
  }

  function closeCommentForm() {
    getRoot().querySelector("[data-pl-comment]").hidden = true;
    state.pendingTarget = null;
  }

  function handleDeliverySettingsInput() {
    const root = getRoot();
    if (!root) return;
    const mode = root.querySelector("[data-pl-delivery-mode]")?.value;
    const endpoint = root.querySelector("[data-pl-endpoint]")?.value;
    const slackWebhookUrl = root.querySelector("[data-pl-slack-webhook]")?.value;

    if (mode) state.options.deliveryMode = mode;
    if (endpoint != null) state.options.endpoint = endpoint.trim();
    if (slackWebhookUrl != null) state.options.slackWebhookUrl = slackWebhookUrl.trim();
    syncDeliverySettingsVisibility();
  }

  function syncDeliverySettingsVisibility() {
    const root = getRoot();
    if (!root) return;
    const mode = state.options.deliveryMode || "receiver";
    const endpointField = root.querySelector("[data-pl-endpoint-field]");
    const slackField = root.querySelector("[data-pl-slack-field]");
    if (endpointField) endpointField.hidden = mode !== "receiver";
    if (slackField) slackField.hidden = mode !== "slack-webhook";
  }

  async function submitComment(event) {
    event.preventDefault();

    const root = getRoot();
    const comment = root.querySelector("[data-pl-comment-text]").value.trim();
    const reviewer = root.querySelector("[data-pl-reviewer]").value.trim();
    if (!comment) return;

    if (state.editingId) {
      const target = state.feedback.find((item) => item.id === state.editingId);
      if (target) {
        target.comment = comment;
        target.reviewer = reviewer;
        renderFeedbackList();
      }
      state.editingId = null;
      closeCommentForm();
      return;
    }

    if (!state.pendingTarget) return;

    const payload = buildPayload(comment, reviewer, state.pendingTarget);
    state.feedback.unshift(payload);
    finalizePendingMarker(payload.id);
    renderFeedbackList();
    expandPanel();
    closeCommentForm();
    setFeedbackMode(false);

    document.dispatchEvent(new CustomEvent("patchloop:feedback", { detail: payload }));

    if (typeof state.options.onSubmit === "function") {
      state.options.onSubmit(payload);
    }

    if (shouldDeliverFeedback()) {
      await deliverFeedback(payload);
      renderFeedbackList();
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
        pageX: Math.round(target.pageX),
        pageY: Math.round(target.pageY),
        documentX: round(target.documentX),
        documentY: round(target.documentY),
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
      screenshot: captureScreenshot(target),
      createdAt: new Date().toISOString()
    };
  }

  function captureScreenshot(target) {
    if (!state.options.captureScreenshot) return null;

    try {
      const width = Math.max(document.documentElement.clientWidth, window.innerWidth, 1);
      const height = Math.max(document.documentElement.clientHeight, window.innerHeight, 1);
      const documentWidth = Math.max(document.documentElement.scrollWidth, width);
      const documentHeight = Math.max(document.documentElement.scrollHeight, height);
      const overlay = screenshotOverlayFor(target);
      const svg = buildScreenshotSvg({
        width,
        height,
        documentWidth,
        documentHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        overlay
      });
      const bytes = byteLength(svg);
      const maxBytes = Number(state.options.screenshotMaxBytes || 0);

      if (maxBytes > 0 && bytes > maxBytes) {
        return {
          status: "omitted",
          reason: "too-large",
          kind: "viewport-svg",
          mimeType: "image/svg+xml",
          width,
          height,
          bytes,
          maxBytes,
          targetOverlay: overlay
        };
      }

      return {
        status: "captured",
        kind: "viewport-svg",
        mimeType: "image/svg+xml",
        width,
        height,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1,
        bytes,
        targetOverlay: overlay,
        dataUrl: `data:image/svg+xml;base64,${base64Encode(svg)}`
      };
    } catch (error) {
      return {
        status: "failed",
        error: error.message
      };
    }
  }

  function buildScreenshotSvg({ width, height, documentWidth, documentHeight, scrollX, scrollY, overlay }) {
    const bodyClone = document.body.cloneNode(true);
    bodyClone.querySelectorAll("[data-patchloop-root], [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection], script").forEach((node) => node.remove());
    bodyClone.querySelectorAll(".pl-target-highlight").forEach((node) => node.classList.remove("pl-target-highlight"));

    const bodyStyle = window.getComputedStyle(document.body);
    const background = bodyStyle.backgroundColor || "#ffffff";
    const color = bodyStyle.color || "#14211d";
    const font = bodyStyle.font || bodyStyle.fontFamily || "system-ui, sans-serif";
    const styles = `${collectReadableStyles()}\n* { box-sizing: border-box; }\n`;
    const overlayMarkup = renderScreenshotOverlay(overlay);

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${escapeXml(background)}"/>
  <foreignObject x="0" y="0" width="${width}" height="${height}">
    <html xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden;background:${escapeHtml(background)};">
      <head>
        <style><![CDATA[${styles.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>
      </head>
      <body style="margin:0;width:${documentWidth}px;min-height:${documentHeight}px;background:${escapeHtml(background)};color:${escapeHtml(color)};font:${escapeHtml(font)};transform:translate(${-Math.round(scrollX)}px, ${-Math.round(scrollY)}px);transform-origin:top left;">
        ${bodyClone.innerHTML}
      </body>
    </html>
  </foreignObject>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#d9e1dd"/>
  ${overlayMarkup}
</svg>`;
  }

  function collectReadableStyles() {
    const chunks = [];
    Array.from(document.styleSheets).forEach((sheet) => {
      try {
        if (sheet.ownerNode?.dataset?.patchloopStyle) return;
        chunks.push(Array.from(sheet.cssRules || []).map((rule) => rule.cssText).join("\n"));
      } catch (_) {
        // Cross-origin stylesheets cannot be read. The snapshot still includes DOM and overlay context.
      }
    });
    return chunks.join("\n");
  }

  function screenshotOverlayFor(target) {
    if (target.kind === "area" && target.area) {
      return {
        kind: "area",
        x: Math.round(target.area.clientX),
        y: Math.round(target.area.clientY),
        width: Math.round(target.area.clientWidth),
        height: Math.round(target.area.clientHeight)
      };
    }

    return {
      kind: "point",
      x: Math.round(target.clientX),
      y: Math.round(target.clientY)
    };
  }

  function renderScreenshotOverlay(overlay) {
    if (!overlay) return "";
    if (overlay.kind === "area") {
      const x = Math.max(0, overlay.x);
      const y = Math.max(0, overlay.y);
      const width = Math.max(1, overlay.width);
      const height = Math.max(1, overlay.height);
      return `
  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="rgba(209, 73, 91, 0.16)" stroke="#d1495b" stroke-width="3"/>
  <circle cx="${x + 18}" cy="${y + 18}" r="14" fill="#d1495b" stroke="#ffffff" stroke-width="3"/>
  <text x="${x + 18}" y="${y + 23}" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="13" font-weight="900">!</text>`;
    }

    return `
  <circle cx="${overlay.x}" cy="${overlay.y}" r="18" fill="#d1495b" stroke="#ffffff" stroke-width="4"/>
  <circle cx="${overlay.x}" cy="${overlay.y}" r="30" fill="none" stroke="#d1495b" stroke-width="3" opacity="0.35"/>`;
  }

  function byteLength(value) {
    if (window.Blob) return new Blob([value]).size;
    return base64Encode(value).length;
  }

  function base64Encode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
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
    console.info("[PatchLoop] delivery", payload.id, payload.delivery);
  }

  function shouldDeliverFeedback() {
    if (state.options.deliveryMode === "none") return false;
    if (state.options.deliveryMode === "slack-webhook") return Boolean(state.options.slackWebhookUrl);
    return Boolean(state.options.endpoint);
  }

  async function deliverFeedback(payload) {
    if (state.options.deliveryMode === "slack-webhook") {
      await postSlackWebhook(payload);
      return;
    }

    await postFeedback(payload);
  }

  async function postSlackWebhook(payload) {
    try {
      await fetch(state.options.slackWebhookUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(buildSlackWebhookPayload(payload))
      });
      payload.delivery = { ok: true, status: "opaque", target: "slack-webhook" };
    } catch (error) {
      payload.delivery = { ok: false, target: "slack-webhook", error: error.message };
    }
    console.info("[PatchLoop] delivery", payload.id, payload.delivery);
  }

  function buildSlackWebhookPayload(payload) {
    const target = payload.target || {};
    const env = payload.environment || {};
    const page = payload.page || {};
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
          text: slackEscape(truncateText(payload.comment || "(empty comment)", 1400))
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Reviewer*\n${slackEscape(payload.reviewer || "(no name)")}` },
          { type: "mrkdwn", text: `*Page*\n${formatSlackLink(page.url, page.title || page.url || "(unknown page)")}` },
          { type: "mrkdwn", text: `*Target*\n${slackEscape(formatTargetForSlack(target))}` },
          { type: "mrkdwn", text: `*Viewport*\n${slackEscape(formatViewportForSlack(env.viewport))}` },
          { type: "mrkdwn", text: `*Selector*\n${formatSlackCode(target.selector || "(none)")}` },
          { type: "mrkdwn", text: `*Created*\n${slackEscape(payload.createdAt || "(unknown)")}` }
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

    if (payload.screenshot && payload.screenshot.status) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `screenshot: ${formatSlackCode(formatDirectScreenshotStatus(payload.screenshot))}`
          }
        ]
      });
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `project: ${formatSlackCode(payload.projectId || "-")} · demo: ${formatSlackCode(payload.demoId || "-")} · id: ${formatSlackCode(payload.id || "-")}`
        }
      ]
    });

    return {
      text: `PatchLoop feedback: ${truncateText(payload.comment || "", 120)}`,
      blocks
    };
  }

  function slackEscape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function formatSlackCode(value) {
    return `\`${slackEscape(truncateText(String(value ?? "").replaceAll("`", "'"), 180))}\``;
  }

  function formatSlackLink(url, label) {
    if (!/^https?:\/\//.test(url || "")) {
      return slackEscape(label || url || "(unknown)");
    }
    return `<${slackEscape(url)}|${slackEscape(truncateText(String(label || url).replaceAll("|", "/"), 120))}>`;
  }

  function formatViewportForSlack(viewport) {
    if (!viewport) return "(unknown)";
    return `${present(viewport.width)}x${present(viewport.height)}`;
  }

  function formatTargetForSlack(target) {
    if (target.kind === "area" && target.area) {
      return `area ${present(target.area.clientWidth)}x${present(target.area.clientHeight)} at ${present(target.area.clientX)},${present(target.area.clientY)}`;
    }
    return `${target.kind || "point"} at ${present(target.clientX)},${present(target.clientY)}`;
  }

  function formatDirectScreenshotStatus(screenshot) {
    if (screenshot.status === "captured") {
      return "captured locally; direct Slack mode needs a public image URL";
    }
    if (screenshot.status === "omitted" && screenshot.reason === "too-large") {
      return `omitted: ${present(screenshot.bytes)} bytes exceeds ${present(screenshot.maxBytes)}`;
    }
    return screenshot.status || "unknown";
  }

  function truncateText(value, max) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function present(value) {
    return value === undefined || value === null || value === "" ? "?" : value;
  }

  function addPin(point) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.dataset.patchloopPin = "true";
    pin.className = "pl-pin";
    pin.style.left = `${point.pageX}px`;
    pin.style.top = `${point.pageY}px`;
    pin.textContent = "…";
    document.body.append(pin);
    return { node: pin, label: pin };
  }

  function clearPins() {
    discardPendingMarker();
    state.editingId = null;
    closeCommentForm();
    document.querySelectorAll("[data-patchloop-pin]").forEach((node) => node.remove());
    document.querySelectorAll("[data-patchloop-area]").forEach((node) => node.remove());
    document.querySelectorAll(".pl-target-highlight").forEach((node) => node.classList.remove("pl-target-highlight"));
    state.feedbackMarkers.clear();
    removeSelectionBox();
    state.feedback = [];
    hideTooltip();
    renderFeedbackList();
  }

  function finalizePendingMarker(feedbackId) {
    if (!state.pendingTarget) return;
    if (state.pendingTarget.markerLabelNode) {
      state.pendingTarget.markerLabelNode.textContent = String(state.feedback.length);
    }
    if (state.pendingTarget.targetElement) {
      unhighlightTarget(state.pendingTarget.targetElement);
    }
    if (feedbackId && state.pendingTarget.markerNode) {
      state.pendingTarget.markerNode.dataset.patchloopFeedbackId = feedbackId;
      const marker = {
        node: state.pendingTarget.markerNode,
        label: state.pendingTarget.markerLabelNode
      };
      state.feedbackMarkers.set(feedbackId, marker);
      bindMarkerHover(marker, feedbackId);
    }
  }

  function discardPendingMarker() {
    if (!state.pendingTarget) return;
    if (state.pendingTarget.markerNode) {
      state.pendingTarget.markerNode.remove();
    }
    if (state.pendingTarget.targetElement) {
      unhighlightTarget(state.pendingTarget.targetElement);
    }
    state.pendingTarget = null;
  }

  function cancelPendingComment() {
    if (state.editingId) {
      state.editingId = null;
      closeCommentForm();
      return;
    }
    discardPendingMarker();
    closeCommentForm();
  }

  function highlightTarget(element) {
    if (!element || !element.classList) return;
    if (element === document.body || element === document.documentElement) return;
    if (element.closest && element.closest("[data-patchloop-root]")) return;
    element.classList.add("pl-target-highlight");
  }

  function unhighlightTarget(element) {
    if (!element || !element.classList) return;
    element.classList.remove("pl-target-highlight");
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    applyCollapseState();
  }

  function applyCollapseState() {
    const root = getRoot();
    if (!root) return;
    const panel = root.querySelector("[data-pl-panel]");
    if (panel) panel.classList.toggle("pl-collapsed", state.collapsed);
    const button = root.querySelector("[data-pl-collapse]");
    if (button) {
      button.setAttribute("aria-expanded", String(!state.collapsed));
      button.textContent = state.collapsed ? "‹" : "›";
      button.setAttribute("title", state.collapsed ? "展開" : "折りたたみ");
    }
  }

  function expandPanel() {
    const root = getRoot();
    if (root) root.querySelector("[data-pl-panel]").hidden = false;
    state.collapsed = false;
    applyCollapseState();
  }

  function renderFeedbackList() {
    const root = getRoot();
    if (!root) return;
    const list = root.querySelector("[data-pl-list]");
    if (!list) return;
    if (state.feedback.length === 0) {
      list.innerHTML = '<p class="pl-feedback-list-empty">まだフィードバックはありません。</p>';
      return;
    }
    list.innerHTML = state.feedback
      .map((item, i) => {
        const num = state.feedback.length - i;
        const kind = (item.target && item.target.kind) || "point";
        const delivery = item.delivery
          ? item.delivery.ok
            ? '<span class="pl-feedback-status pl-feedback-status-ok" title="delivered">✓</span>'
            : '<span class="pl-feedback-status pl-feedback-status-fail" title="delivery failed">✗</span>'
          : "";
        return `
          <article class="pl-feedback-item" data-feedback-id="${escapeHtml(item.id)}">
            <span class="pl-feedback-num kind-${escapeHtml(kind)}">${num}</span>
            <div class="pl-feedback-body">
              <div class="pl-feedback-meta">${escapeHtml(item.reviewer || "(no name)")} ${delivery}</div>
              <div class="pl-feedback-text">${escapeHtml(item.comment || "")}</div>
            </div>
            <div class="pl-feedback-actions">
              <button type="button" data-pl-edit title="編集">編集</button>
              <button type="button" data-pl-delete title="削除">削除</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renumberMarkers() {
    const ordered = state.feedback.slice().reverse();
    ordered.forEach((item, i) => {
      const marker = state.feedbackMarkers.get(item.id);
      if (marker && marker.label) {
        marker.label.textContent = String(i + 1);
      }
    });
  }

  function handleListClick(event) {
    const itemEl = event.target.closest("[data-feedback-id]");
    if (!itemEl) return;
    const id = itemEl.dataset.feedbackId;
    if (event.target.closest("[data-pl-edit]")) {
      startEditFeedback(id);
      return;
    }
    if (event.target.closest("[data-pl-delete]")) {
      deleteFeedback(id);
    }
  }

  function startEditFeedback(id) {
    const item = state.feedback.find((f) => f.id === id);
    if (!item) return;
    if (state.active) setFeedbackMode(false);
    discardPendingMarker();
    hideTooltip();
    state.editingId = id;
    const marker = state.feedbackMarkers.get(id);
    const rect = marker && marker.node ? marker.node.getBoundingClientRect() : null;
    const point = rect
      ? { clientX: rect.left + rect.width / 2, clientY: rect.bottom }
      : { clientX: Math.max(window.innerWidth - 360, 16), clientY: 80 };
    openCommentForm(point, { comment: item.comment, reviewer: item.reviewer });
  }

  function deleteFeedback(id) {
    const marker = state.feedbackMarkers.get(id);
    if (marker) {
      if (marker.node) marker.node.remove();
      state.feedbackMarkers.delete(id);
    }
    state.feedback = state.feedback.filter((f) => f.id !== id);
    if (state.editingId === id) {
      state.editingId = null;
      closeCommentForm();
    }
    renumberMarkers();
    renderFeedbackList();
    hideTooltip();
  }

  function bindMarkerHover(marker, feedbackId) {
    const targets = marker.node === marker.label
      ? [marker.node]
      : [marker.node, marker.label].filter(Boolean);
    targets.forEach((el) => {
      el.addEventListener("mouseenter", (event) => {
        if (state.active) return;
        const item = state.feedback.find((f) => f.id === feedbackId);
        if (!item) return;
        showTooltip(event, item);
      });
      el.addEventListener("mousemove", (event) => {
        if (state.active) return;
        positionTooltip(event);
      });
      el.addEventListener("mouseleave", () => {
        hideTooltip();
      });
    });
  }

  function showTooltip(event, item) {
    const tooltip = getTooltip();
    if (!tooltip) return;
    const reviewer = item.reviewer || "(no name)";
    tooltip.textContent = `${reviewer}\n${item.comment || ""}`;
    tooltip.hidden = false;
    positionTooltip(event);
  }

  function positionTooltip(event) {
    const tooltip = getTooltip();
    if (!tooltip || tooltip.hidden) return;
    const padding = 14;
    const tipWidth = tooltip.offsetWidth || 240;
    const tipHeight = tooltip.offsetHeight || 60;
    const x = Math.min(event.clientX + padding, window.innerWidth - tipWidth - 8);
    const y = Math.min(event.clientY + padding, window.innerHeight - tipHeight - 8);
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTooltip() {
    const tooltip = getTooltip();
    if (!tooltip) return;
    tooltip.hidden = true;
  }

  function getTooltip() {
    return document.querySelector("[data-pl-tooltip]");
  }

  function pointFromEvent(event) {
    return pointFromClient(event.clientX, event.clientY);
  }

  function pointFromClient(clientX, clientY) {
    const pageX = clientX + window.scrollX;
    const pageY = clientY + window.scrollY;
    return {
      x: (clientX / Math.max(document.documentElement.clientWidth, 1)) * 100,
      y: (clientY / Math.max(document.documentElement.clientHeight, 1)) * 100,
      documentX: (pageX / Math.max(document.documentElement.scrollWidth, 1)) * 100,
      documentY: (pageY / Math.max(document.documentElement.scrollHeight, 1)) * 100,
      clientX,
      clientY,
      pageX,
      pageY
    };
  }

  function rectFromPoints(start, end) {
    const leftPx = Math.min(start.clientX, end.clientX);
    const topPx = Math.min(start.clientY, end.clientY);
    const rightPx = Math.max(start.clientX, end.clientX);
    const bottomPx = Math.max(start.clientY, end.clientY);
    const viewportWidth = Math.max(document.documentElement.clientWidth, 1);
    const viewportHeight = Math.max(document.documentElement.clientHeight, 1);
    const pageLeftPx = leftPx + window.scrollX;
    const pageTopPx = topPx + window.scrollY;
    const documentWidth = Math.max(document.documentElement.scrollWidth, 1);
    const documentHeight = Math.max(document.documentElement.scrollHeight, 1);

    return {
      leftPx,
      topPx,
      rightPx,
      bottomPx,
      pageLeftPx,
      pageTopPx,
      widthPx: rightPx - leftPx,
      heightPx: bottomPx - topPx,
      x: (leftPx / viewportWidth) * 100,
      y: (topPx / viewportHeight) * 100,
      width: ((rightPx - leftPx) / viewportWidth) * 100,
      height: ((bottomPx - topPx) / viewportHeight) * 100,
      documentX: (pageLeftPx / documentWidth) * 100,
      documentY: (pageTopPx / documentHeight) * 100,
      documentWidth: ((rightPx - leftPx) / documentWidth) * 100,
      documentHeight: ((bottomPx - topPx) / documentHeight) * 100
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
      left: `${rect.pageLeftPx}px`,
      top: `${rect.pageTopPx}px`,
      width: `${rect.widthPx}px`,
      height: `${rect.heightPx}px`
    });
    const label = document.createElement("span");
    label.textContent = "…";
    area.append(label);
    document.body.append(area);
    return { node: area, label };
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

  function escapeXml(value) {
    return escapeHtml(value).replaceAll("'", "&apos;");
  }

  function injectStyles() {
    if (document.querySelector("[data-patchloop-style]")) return;
    const style = document.createElement("style");
    style.dataset.patchloopStyle = "true";
    style.textContent = `
      .pl-root, .pl-root * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .pl-root [hidden], .pl-comment[hidden], .pl-tooltip[hidden] { display: none !important; }
      .pl-root { position: fixed; z-index: 2147483000; color: #14211d; right: 0; bottom: 20px; }
      .pl-panel { position: absolute; right: 0; bottom: 0; width: min(390px, calc(100vw - 32px)); background: #fff; border: 1px solid #d9e1dd; border-radius: 8px 0 0 8px; box-shadow: 0 22px 70px rgba(20, 33, 29, 0.22); overflow: hidden; transition: transform 250ms ease; }
      .pl-panel header { min-height: 44px; padding: 0 8px 0 6px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d9e1dd; }
      .pl-title { flex: 1; min-width: 0; }
      .pl-handle { min-width: 32px; height: 32px; padding: 0; border: 0; background: transparent; cursor: pointer; font-size: 20px; color: #14211d; border-radius: 6px; font-weight: 700; transition: background 150ms ease, color 150ms ease; }
      .pl-handle:hover { background: #f0f3ef; }
      .pl-handle.pl-mode-on { background: #d1495b; color: #fff; }
      .pl-handle.pl-mode-on:hover { background: #b83d4d; }
      .pl-mode { min-height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid #0f7b63; background: #0f7b63; color: #fff; font-weight: 800; font-size: 12px; cursor: pointer; }
      .pl-mode[aria-pressed="true"] { background: #d1495b; border-color: #d1495b; }
      .pl-panel.pl-collapsed { transform: translateX(calc(100% - 44px)); }
      .pl-panel.pl-collapsed header { border-bottom: 0; }
      .pl-panel.pl-collapsed .pl-title,
      .pl-panel.pl-collapsed .pl-mode { display: none; }
      .pl-panel.pl-collapsed .pl-panel-body { display: none; }
      .pl-panel p { margin: 0; padding: 14px; color: #65716d; font-size: 13px; }
      .pl-actions { display: flex; gap: 8px; padding: 0 14px 14px; }
      .pl-actions button, .pl-form-actions button { min-height: 36px; border-radius: 8px; border: 1px solid #d9e1dd; background: #fff; color: #14211d; padding: 0 12px; cursor: pointer; }
      .pl-form-actions button[type="submit"] { background: #0f7b63; border-color: #0f7b63; color: #fff; font-weight: 800; }
      .pl-delivery-settings { margin: 0 14px 14px; border: 1px solid #d9e1dd; border-radius: 8px; padding: 8px 10px 10px; background: #f7f8f5; }
      .pl-delivery-settings summary { cursor: pointer; color: #14211d; font-weight: 800; font-size: 12px; }
      .pl-delivery-settings label { display: grid; gap: 5px; margin-top: 8px; color: #65716d; font-size: 11px; font-weight: 800; }
      .pl-delivery-settings input, .pl-delivery-settings select { width: 100%; min-height: 32px; border: 1px solid #d9e1dd; border-radius: 6px; background: #fff; color: #14211d; padding: 6px 8px; font: inherit; }
      .pl-feedback-list { max-height: 280px; overflow-y: auto; padding: 0 14px 14px; display: grid; gap: 8px; }
      .pl-feedback-list-empty { margin: 0; color: #65716d; font-size: 13px; padding: 0; }
      .pl-feedback-item { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; padding: 10px; border: 1px solid #d9e1dd; border-radius: 8px; background: #fff; align-items: start; }
      .pl-feedback-num { width: 24px; height: 24px; min-width: 24px; min-height: 24px; box-sizing: border-box; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 900; font-size: 11px; line-height: 1; }
      .pl-feedback-num.kind-point { background: #0f7b63; }
      .pl-feedback-num.kind-area { background: #d1495b; }
      .pl-feedback-body { display: grid; gap: 4px; min-width: 0; }
      .pl-feedback-meta { color: #65716d; font-weight: 700; font-size: 11px; }
      .pl-feedback-text { color: #14211d; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
      .pl-feedback-actions { display: flex; gap: 4px; }
      .pl-feedback-actions button { min-height: 24px; padding: 0 8px; font-size: 11px; border-radius: 6px; border: 1px solid #d9e1dd; background: #fff; color: #14211d; cursor: pointer; font-weight: 700; }
      .pl-feedback-actions [data-pl-delete] { border-color: #d1495b; color: #d1495b; }
      .pl-feedback-status { font-weight: 900; }
      .pl-feedback-status-ok { color: #0f7b63; }
      .pl-feedback-status-fail { color: #d1495b; }
      .pl-tooltip { position: fixed; max-width: 280px; background: #14211d; color: #fff; padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; pointer-events: none; z-index: 2147483002; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.32); white-space: pre-wrap; word-break: break-word; }
      .pl-comment { position: fixed; z-index: 2147483001; width: min(320px, calc(100vw - 24px)); display: grid; gap: 10px; padding: 14px; background: #fff; border: 1px solid #d9e1dd; border-radius: 8px; box-shadow: 0 22px 70px rgba(20, 33, 29, 0.24); }
      .pl-comment label { display: grid; gap: 6px; color: #65716d; font-size: 12px; font-weight: 800; }
      .pl-comment textarea, .pl-comment input { width: 100%; border: 1px solid #d9e1dd; border-radius: 8px; padding: 9px 10px; color: #14211d; font: inherit; resize: vertical; }
      .pl-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .pl-pin { position: absolute; z-index: 2147482999; transform: translate(-50%, -50%); width: 30px; height: 30px; min-width: 30px; min-height: 30px; max-width: 30px; max-height: 30px; box-sizing: border-box; display: grid; place-items: center; padding: 0; line-height: 1; border-radius: 50%; border: 3px solid #fff; background: #d1495b; color: #fff; font: 900 13px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); cursor: pointer; }
      .pl-selection { position: fixed; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; }
      .pl-area { position: absolute; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.16); }
      .pl-area span { position: absolute; top: 6px; left: 6px; width: 30px; height: 30px; box-sizing: border-box; display: grid; place-items: center; border-radius: 50%; border: 3px solid #fff; background: #d1495b; color: #fff; font-weight: 900; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); pointer-events: auto; cursor: pointer; }
      .pl-feedback-active [data-patchloop-pin], .pl-feedback-active .pl-area span { pointer-events: none; }
      .pl-target-highlight { outline: 2px dashed #d1495b; outline-offset: 2px; }
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
