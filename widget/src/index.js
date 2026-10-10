import { pointFromClient, rectFromPoints, rectContainsArea, pointFromStoredTarget, rectFromStoredArea, round, numberOrNull } from "./geometry.js";
import { pointAnchorOffsets, areaAnchorOffsets, geometryFromAnchor, viewportDiffersFromCreation } from "./anchoring.js";
import { selectorFor, textFor } from "./selector.js";
import { resolveSourceContext } from "./source-context.js";
import { DEFAULTS, state } from "./state.js";
import { buildPayload } from "./payload.js";
import { statusLookupUrl, statusLookupIds, statusesFromAnswer, isFinished, initialLookupState, lookupOutcome, lookupAfter } from "./inbox-status.js";
import { loadStoredReviewer, saveReviewer, loadDisplayMode, saveDisplayMode, persistFeedbackList, loadPersistedFeedback, clearPersistedFeedback } from "./persistence.js";
import { safeFilePart, truncateText, present, escapeHtml, slackEscape, formatSlackCode, formatSlackLink, formatViewport, formatTarget, FEEDBACK_STATUS_LABELS } from "../../shared/format.js";

const EXPORT_KIND = "patchloop-feedback-bundle";
// v2 carries an array of feedback (batch export). v1 wrapped a single
// payload; the receiver still accepts that shape for files exported before
// the switch to batch download.
const EXPORT_VERSION = 2;
let pendingInit = null;
const captureEvents = typeof window.PointerEvent === "function"
  ? ["pointerdown", "pointermove", "pointerup"]
  : ["mousedown", "mousemove", "mouseup"];

function init(options = {}) {
  cancelPendingInit();
  // From <head> there is no body yet to mount into; retry once the DOM is ready.
  if (!document.body) {
    pendingInit = () => {
      pendingInit = null;
      init(options);
    };
    document.addEventListener("DOMContentLoaded", pendingInit, { once: true });
    return api;
  }
  // Re-init while comment mode is on must not leave stale mode state
  // (crosshair cursor, active drag) behind the freshly rendered UI.
  state.active = false;
  document.documentElement.classList.remove("pl-feedback-active");
  state.drag = null;
  state.pendingTarget = null;
  state.editingId = null;
  state.commentReturnFocus = null;
  removeSelectionBox();
  state.options = { ...DEFAULTS, ...options };
  state.options.reviewer = initialReviewer(state.options);
  // Resolved once here (option first, meta tags as fallback) so every payload
  // built later carries the same provenance without re-reading the DOM.
  state.options.sourceContext = resolveSourceContext(state.options.sourceContext, document);
  state.displayMode = loadDisplayMode();
  state.inboxStatus = null;
  state.statusLookup = initialLookupState();
  state.statusLookupInFlight = false;
  injectStyles();
  renderShell();
  bindGlobalCapture();
  restorePersistedFeedback();
  applyCollapseState();
  renderFeedbackList();
  refreshInboxStatuses();
  return api;
}

function destroy() {
  cancelPendingInit();
  document.documentElement.classList.remove("pl-feedback-active");
  document.querySelector("[data-patchloop-style]")?.remove();
  document.removeEventListener(captureEvents[0], handleDocumentMouseDown, true);
  document.removeEventListener(captureEvents[1], handleDocumentMouseMove, true);
  document.removeEventListener(captureEvents[2], handleDocumentMouseUp, true);
  document.removeEventListener("pointercancel", cancelCaptureDrag, true);
  document.removeEventListener("keydown", handleCaptureKeydown, true);
  document.removeEventListener("click", suppressDocumentClick, true);
  window.removeEventListener("resize", handleWindowResize);
  window.visualViewport?.removeEventListener("resize", positionVisibleCommentForm);
  window.visualViewport?.removeEventListener("scroll", positionVisibleCommentForm);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.clearTimeout(state.resizeTimer);
  state.inboxStatus = null;
  state.approximateIds.clear();
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
  state.commentReturnFocus = null;
}

function cancelPendingInit() {
  if (!pendingInit) return;
  document.removeEventListener("DOMContentLoaded", pendingInit);
  pendingInit = null;
}

function initialReviewer(options) {
  const configured = String(options.reviewer || "").trim();
  if (configured) return configured;
  return loadStoredReviewer(options.reviewerStorageKey);
}

function renderShell() {
  document.querySelector("[data-patchloop-root]")?.remove();

  const root = document.createElement("div");
  root.dataset.patchloopRoot = "true";
  root.className = `pl-root pl-${state.options.position}`;
  root.innerHTML = `
    <section class="pl-panel pl-collapsed" data-pl-panel aria-label="PatchLoop フィードバック">
      <header>
        <button type="button" class="pl-handle" data-pl-collapse aria-expanded="false" title="フィードバックを開く">フィードバック</button>
        <strong class="pl-title">PatchLoop</strong>
      </header>
      <div class="pl-panel-body" data-pl-body>
        <div class="pl-compose"><button type="button" class="pl-mode" data-pl-mode aria-pressed="false">コメントを追加</button><p data-pl-help>気になる場所を選んで、改善のヒントを残しましょう。</p></div>
        <p class="pl-notice" data-pl-notice role="status" aria-live="polite" hidden></p>
        <fieldset class="pl-display-mode" data-pl-display-mode>
          <legend>マーカーの表示</legend>
          <label><input type="radio" name="patchloop-display-mode" value="normal"${state.displayMode === "normal" ? " checked" : ""} />通常</label>
          <label><input type="radio" name="patchloop-display-mode" value="dots"${state.displayMode === "dots" ? " checked" : ""} />ドットだけ</label>
          <label><input type="radio" name="patchloop-display-mode" value="all"${state.displayMode === "all" ? " checked" : ""} />全部</label>
        </fieldset>
        <div class="pl-list-heading"><strong>このページのコメント</strong><span data-pl-count>0</span></div>
        <div class="pl-feedback-list" data-pl-list>
          <p class="pl-feedback-list-empty">まだコメントはありません。</p>
        </div>
        <div class="pl-actions">
          <button type="button" data-pl-download-all hidden>未送信をまとめてDL</button>
          <button type="button" data-pl-download-again hidden>全件を再ダウンロード</button>
          <button type="button" data-pl-clear hidden>この端末のコメントを消す</button>
        </div>
        ${renderDeliverySettings()}
      </div>
    </section>
    <div class="pl-capture-guide" data-pl-capture-guide hidden><span>場所をクリック・タップして選択<small>Tab + Enter でも選べます</small></span><button type="button" data-pl-stop-capture>終了</button></div>
    <div class="pl-tooltip" id="pl-feedback-tooltip" role="tooltip" data-pl-tooltip hidden></div>
    <form class="pl-comment" data-pl-comment novalidate hidden>
      <div class="pl-form-heading"><strong data-pl-form-title>コメントを追加</strong><span>気づいたことを、ひとつずつ。</span></div>
      <label>
        コメント
        <textarea data-pl-comment-text rows="4" placeholder="どこを、どう変えるとよくなりますか？" required aria-describedby="pl-form-error"></textarea>
      </label>
      <label>
        投稿者
        <input data-pl-reviewer value="${escapeHtml(state.options.reviewer)}" placeholder="表示名" required aria-describedby="pl-form-error" />
      </label>
      <label class="pl-screenshot-option" data-pl-screenshot-field><input type="checkbox" data-pl-include-screenshot${state.options.captureScreenshot ? " checked" : ""} />画面画像を含める</label>
      <p class="pl-capture-note" data-pl-capture-note>画像には画面外の内容が含まれる場合があります。機密情報のあるページでは外してください。</p>
      <p class="pl-form-error" id="pl-form-error" data-pl-form-error role="alert" hidden></p>
      <p class="pl-edit-note" data-pl-edit-note hidden>編集はこの端末に保存されます。受信済みの内容や作成済みの Issue は更新されません。</p>
      <div class="pl-form-actions">
        <button type="button" data-pl-cancel>キャンセル</button>
        <button type="submit" data-pl-submit>コメントを送る</button>
      </div>
      <small class="pl-keyboard-hint">⌘ / Ctrl + Enter で確定 · Esc でキャンセル</small>
    </form>
  `;

  document.body.append(root);

  root.querySelector("[data-pl-collapse]").addEventListener("click", toggleCollapse);
  root.querySelector("[data-pl-mode]").addEventListener("click", toggleFeedbackMode);
  root.querySelector("[data-pl-stop-capture]")?.addEventListener("click", () => setFeedbackMode(false));
  root.querySelector("[data-pl-download-all]").addEventListener("click", downloadUnsentFeedback);
  root.querySelector("[data-pl-download-again]")?.addEventListener("click", () => downloadFeedbackItems(state.feedback));
  root.querySelector("[data-pl-clear]").addEventListener("click", () => {
    if (state.feedback.some((item) => item.delivery?.pending)) return;
    if (window.confirm("この端末に保存したコメントをすべて消します。送信先の内容は削除されません。続けますか？")) clearPins();
  });
  root.querySelector("[data-pl-cancel]").addEventListener("click", cancelPendingComment);
  root.querySelector("[data-pl-comment]").addEventListener("submit", submitComment);
  root.querySelector("[data-pl-comment]").addEventListener("keydown", handleCommentKeydown);
  root.querySelector("[data-pl-reviewer]").addEventListener("input", () => clearFormError(root.querySelector("[data-pl-comment]")));
  root.querySelector("[data-pl-comment-text]").addEventListener("input", () => clearFormError(root.querySelector("[data-pl-comment]")));
  root.querySelector("[data-pl-list]").addEventListener("click", handleListClick);
  root.querySelector("[data-pl-display-mode]").addEventListener("change", handleDisplayModeChange);
  root.querySelector("[data-pl-delivery-settings]")?.addEventListener("input", handleDeliverySettingsInput);
  root.querySelector("[data-pl-delivery-settings]")?.addEventListener("change", handleDeliverySettingsInput);
  syncDeliverySettingsVisibility();
}

function handleDisplayModeChange(event) {
  state.displayMode = event.target.value;
  saveDisplayMode(state.displayMode);
  applyMarkerDisplay();
}

function renderDeliverySettings() {
  if (!state.options.showDeliverySettings) return "";

  return `
        <details class="pl-delivery-settings" data-pl-delivery-settings>
          <summary>送信先・設定</summary>
          <label>
            送信先
            <select data-pl-delivery-mode>
              <option value="receiver"${state.options.deliveryMode === "receiver" ? " selected" : ""}>受信箱へ送信</option>
              <option value="slack-webhook"${state.options.deliveryMode === "slack-webhook" ? " selected" : ""}>Slack に直接送信（結果確認不可）</option>
              <option value="download"${state.options.deliveryMode === "download" ? " selected" : ""}>ファイルで共有</option>
              <option value="none"${state.options.deliveryMode === "none" ? " selected" : ""}>この端末に保存</option>
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
  document.removeEventListener(captureEvents[0], handleDocumentMouseDown, true);
  document.removeEventListener(captureEvents[1], handleDocumentMouseMove, true);
  document.removeEventListener(captureEvents[2], handleDocumentMouseUp, true);
  document.removeEventListener("click", suppressDocumentClick, true);
  document.addEventListener(captureEvents[0], handleDocumentMouseDown, true);
  document.addEventListener(captureEvents[1], handleDocumentMouseMove, true);
  document.addEventListener(captureEvents[2], handleDocumentMouseUp, true);
  document.addEventListener("click", suppressDocumentClick, true);
  document.removeEventListener("pointercancel", cancelCaptureDrag, true);
  document.addEventListener("pointercancel", cancelCaptureDrag, true);
  document.removeEventListener("keydown", handleCaptureKeydown, true);
  document.addEventListener("keydown", handleCaptureKeydown, true);
  window.removeEventListener("resize", handleWindowResize);
  window.addEventListener("resize", handleWindowResize);
  window.visualViewport?.removeEventListener("resize", positionVisibleCommentForm);
  window.visualViewport?.addEventListener("resize", positionVisibleCommentForm);
  window.visualViewport?.removeEventListener("scroll", positionVisibleCommentForm);
  window.visualViewport?.addEventListener("scroll", positionVisibleCommentForm);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function cancelCaptureDrag() {
  removeSelectionBox();
  state.drag = null;
  state.suppressNextClick = false;
}

function handleCaptureKeydown(event) {
  if (!state.active || event.isComposing) return;
  if (event.key === "Escape") {
    if (event.target.closest("[data-pl-comment]")) return;
    event.preventDefault();
    cancelPendingComment();
    setFeedbackMode(false);
    return;
  }
  if (event.target.closest("[data-patchloop-root]") || event.target.closest("[data-patchloop-pin]") || event.target.closest("[data-patchloop-area]")) return;
  if (event.key !== "Enter" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target === document.body || event.target === document.documentElement) return;
  const rect = event.target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const capture = {
    target: event.target, button: 0, keyboard: true,
    clientX: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
    clientY: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)),
    preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation()
  };
  handleDocumentMouseDown(capture);
  handleDocumentMouseUp(capture);
  state.suppressNextClick = false;
}

function handleDocumentMouseDown(event) {
  if (!state.active) return;
  // Secondary/middle buttons keep their native behavior (context menu,
  // autoscroll); capturing them would drop a pin under the context menu.
  if (event.button !== 0 || event.isPrimary === false) return;
  if (event.target.closest("[data-patchloop-root]")) return;

  if (event.pointerType !== "touch") event.preventDefault();
  event.stopPropagation();

  state.drag = {
    startedAt: pointFromEvent(event),
    latest: pointFromEvent(event),
    target: event.target,
    keyboard: event.keyboard === true,
    touch: event.pointerType === "touch",
    isDragging: false
  };
  state.suppressNextClick = true;
}

function handleDocumentMouseMove(event) {
  if (!state.active || !state.drag) return;
  // Touch uses a tap to capture. Moving cancels capture and leaves native page
  // scrolling available, rather than turning every swipe into an area selection.
  if (state.drag.touch) {
    if (Math.hypot(event.clientX - state.drag.startedAt.clientX, event.clientY - state.drag.startedAt.clientY) > 8) cancelCaptureDrag();
    return;
  }
  // The mouseup can be missed entirely (button released outside the
  // window); event.buttons reports what is actually held, so a move
  // without the primary button cancels the drag instead of dragging
  // a ghost selection box around.
  if ((event.buttons & 1) === 0) {
    removeSelectionBox();
    state.drag = null;
    return;
  }
  if (event.target.closest("[data-patchloop-root]")) return;

  event.preventDefault();
  event.stopPropagation();

  state.drag.latest = pointFromEvent(event);
  const rect = rectFromPoints(state.drag.startedAt, state.drag.latest, viewportMetrics());
  state.drag.isDragging = rect.widthPx > 8 || rect.heightPx > 8;

  if (state.drag.isDragging) {
    renderSelectionBox(rect);
  }
}

function handleDocumentMouseUp(event) {
  if (!state.active || !state.drag) return;
  if (event.target.closest("[data-patchloop-root]")) {
    removeSelectionBox();
    state.drag = null;
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const start = state.drag.startedAt;
  const end = pointFromEvent(event);
  const rect = rectFromPoints(start, end, viewportMetrics());
  const target = state.drag.keyboard ? state.drag.target : document.elementFromPoint(start.clientX, start.clientY) || state.drag.target;

  discardPendingMarker();
  // A new capture supersedes an interrupted edit; a stale editingId would
  // route the submit into the edit branch and silently overwrite that item.
  state.editingId = null;

  let marker;
  if (state.drag.isDragging) {
    marker = addArea(rect);
    const areaAnchor = buildAreaAnchor(target, rect);
    state.pendingTarget = {
      kind: "area",
      ...pointFromClient(rect.leftPx, rect.topPx, viewportMetrics()),
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
      selector: selectorFor(target, document.body),
      elementText: textFor(target),
      anchor: areaAnchor.anchor,
      anchorElement: areaAnchor.anchorElement,
      markerNode: marker.node,
      markerLabelNode: marker.label,
      targetElement: target
    };
    openCommentForm({ clientX: rect.rightPx, clientY: rect.bottomPx });
  } else {
    const point = pointFromEvent(event);
    marker = addPin(point);
    const pointAnchor = buildPointAnchor(target, point);
    state.pendingTarget = {
      kind: "point",
      ...point,
      selector: selectorFor(target, document.body),
      elementText: textFor(target),
      anchor: pointAnchor.anchor,
      anchorElement: pointAnchor.anchorElement,
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
  const root = getRoot();
  if (!root) return;
  state.active = nextValue;
  document.documentElement.classList.toggle("pl-feedback-active", state.active);
  const handleBtn = root.querySelector("[data-pl-collapse]");
  if (handleBtn) handleBtn.classList.toggle("pl-mode-on", state.active);
  const modeBtn = root.querySelector("[data-pl-mode]");
  modeBtn.textContent = state.active ? "場所の選択を終了" : "コメントを追加";
  modeBtn.setAttribute("aria-pressed", String(state.active));
  const guide = root.querySelector("[data-pl-capture-guide]");
  const focusInGuide = guide?.contains(document.activeElement);
  const focusInPanelBody = document.activeElement === modeBtn || root.querySelector("[data-pl-body]")?.contains(document.activeElement);
  if (guide) guide.hidden = !state.active;
  if (state.active) {
    state.collapsed = true;
    applyCollapseState();
    if (focusInPanelBody) root.querySelector("[data-pl-stop-capture]")?.focus({ preventScroll: true });
  } else if (focusInGuide) {
    handleBtn?.focus({ preventScroll: true });
  }
  root.querySelector("[data-pl-help]").textContent = state.active ? "場所をクリック、または範囲をドラッグ。Tab で移動し Enter でも選べます。Esc で終了。" : "気になる場所を選んで、改善のヒントを残しましょう。";
  if (!state.active) {
    removeSelectionBox();
    state.drag = null;
    state.suppressNextClick = false;
  }
}

function openCommentForm(point, options = {}) {
  const form = getRoot().querySelector("[data-pl-comment]");
  if (form.hidden) {
    const focused = document.activeElement;
    state.commentReturnFocus = focused !== document.body && focused !== document.documentElement ? focused : null;
  }
  form.hidden = false;
  const editing = Boolean(state.editingId);
  const title = form.querySelector("[data-pl-form-title]");
  if (title) title.textContent = editing ? "コメントを編集" : "コメントを追加";
  const submit = form.querySelector("[data-pl-submit]");
  if (submit) submit.textContent = editing ? "変更を保存" : "コメントを送る";
  const editNote = form.querySelector("[data-pl-edit-note]");
  if (editNote) editNote.hidden = !editing;
  const screenshotField = form.querySelector("[data-pl-screenshot-field]");
  const captureNote = form.querySelector("[data-pl-capture-note]");
  if (screenshotField) screenshotField.hidden = editing || !state.options.captureScreenshot;
  if (captureNote) captureNote.hidden = editing || !state.options.captureScreenshot;
  const screenshotInput = form.querySelector("[data-pl-include-screenshot]");
  if (screenshotInput) screenshotInput.checked = state.options.captureScreenshot;
  clearFormError(form);
  const commentEl = form.querySelector("[data-pl-comment-text]");
  const reviewerEl = form.querySelector("[data-pl-reviewer]");
  commentEl.value = options.comment != null ? options.comment : "";
  if (options.reviewer != null) {
    reviewerEl.value = options.reviewer;
  }
  positionCommentForm(form, point);
  commentEl.focus({ preventScroll: true });
}

function positionVisibleCommentForm() {
  const form = getRoot()?.querySelector("[data-pl-comment]");
  if (!form || form.hidden) return;
  const rect = form.getBoundingClientRect();
  positionCommentForm(form, { clientX: rect.left - 14, clientY: rect.top - 14 });
}

function positionCommentForm(form, point) {
  // The form's height varies with settings and viewport; keep all actions in view.
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  form.style.maxHeight = `${Math.max(100, height - 16)}px`;
  const rect = form.getBoundingClientRect();
  form.style.left = `${Math.max(left + 8, Math.min(point.clientX + 14, left + width - rect.width - 8))}px`;
  form.style.top = `${Math.max(top + 8, Math.min(point.clientY + 14, top + height - rect.height - 8))}px`;
}

function closeCommentForm() {
  const form = getRoot().querySelector("[data-pl-comment]");
  const wasOpen = !form.hidden;
  clearFormError(form);
  form.hidden = true;
  state.pendingTarget = null;
  const returnFocus = state.commentReturnFocus;
  state.commentReturnFocus = null;
  if (!wasOpen) return;
  if (returnFocus?.isConnected && !form.contains(returnFocus)) {
    returnFocus.focus({ preventScroll: true });
    if (document.activeElement === returnFocus) return;
  }
  getRoot().querySelector("[data-pl-collapse]")?.focus({ preventScroll: true });
}

function handleCommentKeydown(event) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelPendingComment();
    return;
  }
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  const form = event.currentTarget;
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    // Safari 15 has no requestSubmit; clicking the submit button keeps
    // the submit event (and its validation) on the same path.
    form.querySelector('button[type="submit"]')?.click();
  }
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
  updateDownloadAllButton();
}

function showFormError(form, message) {
  const errorEl = form?.querySelector("[data-pl-form-error]");
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearFormError(form) {
  const errorEl = form?.querySelector("[data-pl-form-error]");
  if (!errorEl) return;
  errorEl.textContent = "";
  errorEl.hidden = true;
}

async function submitComment(event) {
  event.preventDefault();

  const root = getRoot();
  const form = root.querySelector("[data-pl-comment]");
  const comment = root.querySelector("[data-pl-comment-text]").value.trim();
  const reviewer = root.querySelector("[data-pl-reviewer]").value.trim();
  if (!comment) {
    showFormError(form, "コメントを入力してください。");
    root.querySelector("[data-pl-comment-text]").focus();
    return;
  }
  if (!reviewer) {
    showFormError(form, "投稿者名を入力してください。");
    root.querySelector("[data-pl-reviewer]").focus();
    return;
  }
  clearFormError(form);

  if (state.editingId) {
    const target = state.feedback.find((item) => item.id === state.editingId);
    if (target) {
      const changed = target.comment !== comment || target.reviewer !== reviewer;
      target.comment = comment;
      target.reviewer = reviewer;
      const submitted = target.delivery?.ok === true || (target.delivery?.target === "slack-webhook" && target.delivery.ok === null);
      if (changed && (submitted || target.exported)) target.localEdited = true;
      // Re-export the local change; receivers still deduplicate the original ID.
      if (changed && target.exported) {
        delete target.exported;
        delete target.exportedAt;
        delete target.exportedFileName;
      }
      saveReviewer(reviewer);
      persistFeedbackList();
      renumberMarkers();
      renderFeedbackList();
    }
    state.editingId = null;
    closeCommentForm();
    showWidgetNotice("変更をこの端末に保存しました。送信先の内容は更新されません。");
    return;
  }

  if (!state.pendingTarget) return;

  saveReviewer(reviewer);
  const includeScreenshot = form.querySelector("[data-pl-include-screenshot]")?.checked ?? state.options.captureScreenshot;
  const payload = buildPayload(comment, reviewer, state.pendingTarget, includeScreenshot);
  const delivering = shouldDeliverFeedback();
  if (delivering) payload.delivery = pendingDelivery();
  state.feedback.unshift(payload);
  finalizePendingMarker(payload);
  persistFeedbackList();
  renderFeedbackList();
  expandPanel();
  closeCommentForm();

  document.dispatchEvent(new CustomEvent("patchloop:feedback", { detail: payload }));

  if (typeof state.options.onSubmit === "function") {
    try {
      Promise.resolve(state.options.onSubmit(payload)).catch(reportSubmitCallbackError);
    } catch (error) {
      reportSubmitCallbackError(error);
    }
  }

  if (delivering) {
    await deliverFeedback(payload);
    if (getRoot() !== root) return;
    persistFeedbackList();
    renderFeedbackList();
    showWidgetNotice(deliveryStatusText(payload.delivery), payload.delivery.ok === false);
  } else {
    showWidgetNotice(state.options.deliveryMode === "download" ? "コメントを保存しました。「未送信を書き出す」から共有できます。" : "コメントをこの端末に保存しました。外部には送信していません。");
  }
}

function showWidgetNotice(message, error = false) {
  const notice = getRoot()?.querySelector("[data-pl-notice]");
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.state = error ? "error" : "success";
  notice.hidden = false;
}

function reportSubmitCallbackError(error) {
  console.warn("[PatchLoop] onSubmit failed", error);
}

async function postFeedback(payload) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.options.ingestKey) {
      headers["X-PatchLoop-Ingest-Key"] = state.options.ingestKey;
    }
    const response = await fetchWithTimeout(state.options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    payload.delivery = { ok: response.ok, status: response.status };
  } catch (error) {
    payload.delivery = { ok: false, error: error.message };
  }
  console.info("[PatchLoop] delivery", payload.id, payload.delivery);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function restorePersistedFeedback() {
  removeCommittedMarkers();
  state.feedbackMarkers.clear();
  state.feedback = [];

  if (!state.options.persistFeedback) return;

  const stored = loadPersistedFeedback();
  if (!stored.length) return;

  state.feedback = stored;
  state.feedback.forEach((item) => {
    if (item.delivery?.pending) item.delivery = { ok: null, interrupted: true, target: item.delivery.target };
  });
  restoreFeedbackMarkers();
  persistFeedbackList();
}

function shouldDeliverFeedback() {
  if (state.options.deliveryMode === "none") return false;
  // Download mode no longer ships per comment; the reviewer exports the
  // unsent batch on demand via the panel button.
  if (state.options.deliveryMode === "download") return false;
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

function pendingDelivery() {
  return { pending: true, target: state.options.deliveryMode === "slack-webhook" ? "slack-webhook" : "receiver" };
}

// Demo-scoped batch export: write every still-unsent comment as one bundle,
// then flag them as exported so the next batch skips them. Replaces the old
// one-file-per-comment download, which buried reviewers (and receivers) under
// a file per click.
function downloadUnsentFeedback() {
  const unsent = state.feedback.filter((item) => !item.exported);
  downloadFeedbackItems(unsent);
}

function downloadFeedbackItems(items) {
  if (items.length === 0) return;

  const exportedAt = new Date().toISOString();
  try {
    const bundle = buildFeedbackBundle(items.map((item) => {
      const copy = { ...item };
      delete copy.exported;
      delete copy.exportedAt;
      delete copy.exportedFileName;
      delete copy.localEdited;
      return copy;
    }), exportedAt);
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = batchBundleFileName(items.length);
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    // Flag after the bundle is serialized, so the downloaded file does not
    // carry the local exported markers.
    items.forEach((item) => {
      item.exported = true;
      item.exportedAt = exportedAt;
      item.exportedFileName = link.download;
    });
    persistFeedbackList();
    renderFeedbackList();
    showWidgetNotice("ファイルの保存を開始しました。保存できなかった場合は「全件を再ダウンロード」を使ってください。");
    console.info("[PatchLoop] batch download", items.length, link.download);
  } catch (error) {
    showWidgetNotice("ファイルを書き出せませんでした。もう一度お試しください。", true);
    console.warn("[PatchLoop] batch download failed", error);
  }
}

function buildFeedbackBundle(feedbackList, exportedAt) {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt,
    projectId: state.options.projectId || "",
    demoId: state.options.demoId || "",
    feedback: feedbackList
  };
}

function batchBundleFileName(count) {
  const project = safeFilePart(state.options.projectId || "patchloop");
  const demo = safeFilePart(state.options.demoId || "feedback");
  const stamp = safeFilePart(new Date().toISOString());
  return `${project}-${demo}-${count}-${stamp}.patchloop-feedback.json`;
}

function updateDownloadAllButton() {
  const root = getRoot();
  if (!root) return;
  const button = root.querySelector("[data-pl-download-all]");
  if (!button) return;
  const again = root.querySelector("[data-pl-download-again]");
  if (again) again.hidden = state.options.deliveryMode !== "download" || state.feedback.length === 0;
  if (state.options.deliveryMode !== "download") {
    button.hidden = true;
    return;
  }
  const unsent = state.feedback.filter((item) => !item.exported).length;
  button.hidden = false;
  button.disabled = unsent === 0;
  button.textContent = unsent > 0 ? `未送信を書き出す（${unsent}）` : "すべて書き出し済み";
}

async function postSlackWebhook(payload) {
  try {
    await fetchWithTimeout(state.options.slackWebhookUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(buildSlackWebhookPayload(payload))
    });
    // no-cors gives an opaque response: we know nothing about the outcome,
    // so report "unknown" instead of pretending it succeeded.
    payload.delivery = { ok: null, status: "unknown", target: "slack-webhook" };
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
        text: truncateText(slackEscape(payload.comment || "(empty comment)"), 1400)
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Reviewer*\n${slackEscape(payload.reviewer || "(no name)")}` },
        { type: "mrkdwn", text: `*Page*\n${formatSlackLink(page.url, page.title || page.url || "(unknown page)")}` },
        { type: "mrkdwn", text: `*Target*\n${slackEscape(formatTarget(target))}` },
        { type: "mrkdwn", text: `*Viewport*\n${slackEscape(formatViewport(env.viewport))}` },
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
        text: `*Element text*\n>${truncateText(slackEscape(target.text), 500).replaceAll("\n", "\n>")}`
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

function formatDirectScreenshotStatus(screenshot) {
  if (screenshot.status === "captured") {
    return "captured locally; direct Slack mode needs a public image URL";
  }
  if (screenshot.status === "omitted" && screenshot.reason === "too-large") {
    return `omitted: ${present(screenshot.bytes)} bytes exceeds ${present(screenshot.maxBytes)}`;
  }
  return screenshot.status || "unknown";
}

function addPin(point) {
  const pin = document.createElement("button");
  pin.type = "button";
  pin.dataset.patchloopPin = "true";
  pin.className = "pl-pin";
  Object.assign(pin.style, markerPosition(point.pageX, point.pageY));
  pin.textContent = "…";
  pin.setAttribute("aria-label", "コメント入力中の位置");
  document.body.append(pin);
  return { node: pin, label: pin };
}

function restoreFeedbackMarkers() {
  removeCommittedMarkers();
  state.feedbackMarkers.clear();

  state.feedback.slice().reverse().forEach((item, index) => {
    const marker = markerFromFeedback(item);
    if (!marker) return;
    updateMarkerLabel(marker, item, index + 1);
    marker.node.dataset.patchloopFeedbackId = item.id;
    state.feedbackMarkers.set(item.id, marker);
    bindMarkerHover(marker, item.id);
    bindMarkerActivation(marker, item.id);
    setMarkerApproximate(marker, state.approximateIds.has(item.id));
  });
}

function markerFromFeedback(item) {
  const target = item?.target || {};
  const geometry = reanchorGeometry(target);
  if (geometry) {
    refreshTargetCoordinates(target, geometry);
    state.approximateIds.delete(item.id);
  } else if (viewportDiffersFromCreation(item, viewportMetrics())) {
    state.approximateIds.add(item.id);
  }

  if (target.kind === "area" && target.area) {
    const rect = rectFromStoredArea(target.area, viewportMetrics());
    if (!rect) return null;
    return addArea(rect);
  }

  const point = pointFromStoredTarget(target, viewportMetrics());
  return point ? addPin(point) : null;
}

// --- Re-anchoring (issue #41) -------------------------------------------
// Markers are anchored to their target element via selector + the position
// inside the element rect (percent), so they can follow layout reflows
// (window resize, restore at a different viewport). Absolute page pixels
// remain the fallback when the element cannot be resolved.

function pointAnchorFor(element, point) {
  const rect = elementRectOrNull(element);
  return rect ? pointAnchorOffsets(rect, point) : null;
}

function areaAnchorFor(element, rect) {
  const elementRect = elementRectOrNull(element);
  return elementRect ? areaAnchorOffsets(elementRect, rect) : null;
}

// Anchoring to oversized containers (body, main, …) is unstable: a few
// percent of an element taller than the viewport translates to hundreds of
// pixels whenever the container grows or reflows. Only elements that fit
// inside one viewport qualify; markers without a qualifying element stay on
// their page pixels and report an approximate position instead.
function anchorableElement(element) {
  if (!element) return null;
  if (element === document.body || element === document.documentElement) return null;
  if (element.closest && element.closest("[data-patchloop-root]")) return null;
  const rect = elementRectOrNull(element);
  if (!rect) return null;
  if (rect.width > window.innerWidth || rect.height > window.innerHeight) return null;
  return element;
}

function buildPointAnchor(element, point) {
  const anchorElement = anchorableElement(element);
  const offsets = anchorElement && pointAnchorFor(anchorElement, point);
  if (!offsets) return { anchor: null, anchorElement: null };
  return { anchor: { ...offsets, selector: selectorFor(anchorElement, document.body) }, anchorElement };
}

// Drags often start in the gap between elements; the element under the
// area's center is the better anchor candidate for what the area covers.
// From there, climb to the nearest anchorable ancestor that contains the
// dragged rect: a tiny element under the center produces huge relative
// offsets that blow up whenever its own size changes (e.g. text wrapping).
function buildAreaAnchor(startElement, rect) {
  const centerElement = document.elementFromPoint(
    Math.min(Math.max(rect.leftPx + rect.widthPx / 2, 0), window.innerWidth - 1),
    Math.min(Math.max(rect.topPx + rect.heightPx / 2, 0), window.innerHeight - 1)
  );
  let anchorElement = anchorableElement(centerElement) || anchorableElement(startElement);

  let cursor = anchorElement;
  for (let depth = 0; cursor && depth < 6; depth++) {
    if (rectContainsArea(cursor.getBoundingClientRect(), rect)) {
      anchorElement = cursor;
      break;
    }
    const parent = anchorableElement(cursor.parentElement);
    if (!parent) break;
    cursor = parent;
    anchorElement = parent;
  }

  const offsets = anchorElement && areaAnchorFor(anchorElement, rect);
  if (!offsets) return { anchor: null, anchorElement: null };
  return { anchor: { ...offsets, selector: selectorFor(anchorElement, document.body) }, anchorElement };
}

function elementRectOrNull(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return rect;
}

function elementForSelector(selector) {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch (_) {
    return null;
  }
}

function reanchorGeometry(target, element) {
  const anchor = target && target.anchor;
  if (!anchor || numberOrNull(anchor.x) == null || numberOrNull(anchor.y) == null) return null;
  const rect = elementRectOrNull(element)
    || elementRectOrNull(elementForSelector(anchor.selector || target.selector));
  if (!rect) return null;
  return geometryFromAnchor(target.kind, anchor, rect, window.scrollX, window.scrollY);
}

function refreshTargetCoordinates(target, geometry) {
  if (geometry.kind === "area" && target.area) {
    const topLeft = pointFromClient(geometry.pageLeftPx - window.scrollX, geometry.pageTopPx - window.scrollY, viewportMetrics());
    const viewportWidth = Math.max(document.documentElement.clientWidth, 1);
    const viewportHeight = Math.max(document.documentElement.clientHeight, 1);
    const documentWidth = Math.max(document.documentElement.scrollWidth, 1);
    const documentHeight = Math.max(document.documentElement.scrollHeight, 1);

    assignPointFields(target, topLeft);
    Object.assign(target.area, {
      x: round(topLeft.x),
      y: round(topLeft.y),
      width: round((geometry.widthPx / viewportWidth) * 100),
      height: round((geometry.heightPx / viewportHeight) * 100),
      clientX: Math.round(topLeft.clientX),
      clientY: Math.round(topLeft.clientY),
      clientWidth: Math.round(geometry.widthPx),
      clientHeight: Math.round(geometry.heightPx),
      pageX: Math.round(topLeft.pageX),
      pageY: Math.round(topLeft.pageY),
      documentX: round(topLeft.documentX),
      documentY: round(topLeft.documentY),
      documentWidth: round((geometry.widthPx / documentWidth) * 100),
      documentHeight: round((geometry.heightPx / documentHeight) * 100)
    });
    return;
  }

  const point = pointFromClient(geometry.pageX - window.scrollX, geometry.pageY - window.scrollY, viewportMetrics());
  assignPointFields(target, point);
}

function assignPointFields(target, point) {
  target.x = round(point.x);
  target.y = round(point.y);
  target.clientX = Math.round(point.clientX);
  target.clientY = Math.round(point.clientY);
  target.pageX = Math.round(point.pageX);
  target.pageY = Math.round(point.pageY);
  target.documentX = round(point.documentX);
  target.documentY = round(point.documentY);
}

function repositionMarker(marker, target) {
  if (!marker || !marker.node) return;
  if (target.kind === "area" && target.area) {
    Object.assign(marker.node.style, {
      ...markerPosition(target.area.pageX, target.area.pageY),
      width: `${target.area.clientWidth}px`,
      height: `${target.area.clientHeight}px`
    });
    return;
  }
  Object.assign(marker.node.style, markerPosition(target.pageX, target.pageY));
}

// #173: markers are position: absolute children of body, so their left/top
// resolve against body's padding box whenever body (or html) is a containing
// block: a scroll-locked modal (position: fixed; top: -<scroll>px), a
// positioned body, a body moved by a translate, etc. Measure where left/top 0
// lands with a throwaway probe instead of listing every CSS property that
// makes a containing block, and subtract it from the page coordinates. Only
// the origin is compensated: a body that is scaled or rotated still places
// markers off. The probe's inline !important declarations keep host rules
// such as `body > div` off it, and its fixed zero size and hidden overflow
// keep a host ::before / ::after from growing it while it is measured.
const ORIGIN_PROBE_STYLE = "all:initial!important;display:block!important;position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;overflow:hidden!important";

function markerPosition(pageX, pageY) {
  const probe = document.createElement("div");
  probe.style.cssText = ORIGIN_PROBE_STYLE;
  document.body.append(probe);
  const origin = probe.getBoundingClientRect();
  probe.remove();
  return { left: `${pageX - window.scrollX - origin.left}px`, top: `${pageY - window.scrollY - origin.top}px` };
}

function setMarkerApproximate(marker, isApproximate) {
  if (!marker || !marker.node) return;
  marker.node.classList.toggle("pl-marker-approx", Boolean(isApproximate));
  if (isApproximate) {
    marker.node.title = "ウィンドウサイズが変わったため、位置が近似になっています";
  } else {
    marker.node.removeAttribute("title");
  }
}

function handleWindowResize() {
  positionVisibleCommentForm();
  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(reanchorAllMarkers, 200);
}

function reanchorAllMarkers() {
  let changed = false;

  state.feedback.forEach((item) => {
    const marker = state.feedbackMarkers.get(item.id);
    const geometry = reanchorGeometry(item.target);
    if (geometry) {
      refreshTargetCoordinates(item.target, geometry);
      repositionMarker(marker, item.target);
      state.approximateIds.delete(item.id);
      setMarkerApproximate(marker, false);
      changed = true;
    } else {
      const isApproximate = viewportDiffersFromCreation(item, viewportMetrics());
      if (isApproximate) state.approximateIds.add(item.id);
      else state.approximateIds.delete(item.id);
      setMarkerApproximate(marker, isApproximate);
    }
  });

  if (state.pendingTarget) {
    const pending = state.pendingTarget;
    const geometry = reanchorGeometry(pending, pending.anchorElement);
    if (geometry) {
      refreshTargetCoordinates(pending, geometry);
      repositionMarker({ node: pending.markerNode }, pending);
    }
  }

  if (changed) persistFeedbackList();
  renderFeedbackList();
}

function removeCommittedMarkers() {
  document.querySelectorAll("[data-patchloop-pin]").forEach((node) => node.remove());
  document.querySelectorAll("[data-patchloop-area]").forEach((node) => node.remove());
}

function clearPins() {
  discardPendingMarker();
  state.editingId = null;
  closeCommentForm();
  removeCommittedMarkers();
  document.querySelectorAll(".pl-target-highlight").forEach((node) => node.classList.remove("pl-target-highlight"));
  state.feedbackMarkers.clear();
  state.approximateIds.clear();
  removeSelectionBox();
  state.feedback = [];
  clearPersistedFeedback();
  hideTooltip();
  renderFeedbackList();
}

function finalizePendingMarker(item) {
  if (!state.pendingTarget) return;
  if (state.pendingTarget.targetElement) {
    unhighlightTarget(state.pendingTarget.targetElement);
  }
  if (state.pendingTarget.markerNode) {
    state.pendingTarget.markerNode.dataset.patchloopFeedbackId = item.id;
    const marker = {
      node: state.pendingTarget.markerNode,
      label: state.pendingTarget.markerLabelNode
    };
    updateMarkerLabel(marker, item, state.feedback.length);
    state.feedbackMarkers.set(item.id, marker);
    bindMarkerHover(marker, item.id);
    bindMarkerActivation(marker, item.id);
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
  if (!state.collapsed) refreshInboxStatuses();
}

function applyCollapseState() {
  const root = getRoot();
  if (!root) return;
  const panel = root.querySelector("[data-pl-panel]");
  if (panel) panel.classList.toggle("pl-collapsed", state.collapsed);
  const button = root.querySelector("[data-pl-collapse]");
  if (button) {
    button.setAttribute("aria-expanded", String(!state.collapsed));
    button.textContent = state.collapsed ? "フィードバック" : "閉じる";
    button.setAttribute("title", state.collapsed ? "フィードバックを開く" : "フィードバックを閉じる");
    button.setAttribute("aria-label", state.collapsed ? "フィードバックを開く" : "フィードバックを閉じる");
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
  updateDownloadAllButton();
  applyMarkerDisplay();
  const count = root.querySelector("[data-pl-count]");
  if (count) count.textContent = String(state.feedback.length);
  const clear = root.querySelector("[data-pl-clear]");
  if (clear) clear.hidden = state.feedback.length === 0;
  if (clear) clear.disabled = state.feedback.some((item) => item.delivery?.pending);
  // A comment focused from its marker stays focused across the re-render
  // below, which replaces every list item (a delivery reply, re-anchoring).
  const focused = document.activeElement;
  const focusedId = list.contains(focused) && focused.matches("[data-feedback-id]") ? focused.dataset.feedbackId : null;
  if (state.feedback.length === 0) {
    list.innerHTML = '<p class="pl-feedback-list-empty">まだコメントはありません。<br />「コメントを追加」から最初の気づきを残しましょう。</p>';
    return;
  }
  list.innerHTML = state.feedback
    .map((item, i) => {
      const num = state.feedback.length - i;
      const kind = (item.target && item.target.kind) || "point";
      const delivery = item.localEdited
        ? '<span class="pl-feedback-status pl-feedback-status-unknown">ローカル変更・送信先には未反映</span>'
        : item.delivery?.pending
          ? '<span class="pl-feedback-status pl-feedback-status-unknown">送信中…</span>'
        : item.delivery
        ? item.delivery.ok === null
          ? `<span class="pl-feedback-status pl-feedback-status-unknown" title="${escapeHtml(deliveryStatusText(item.delivery))}">結果未確認</span>`
          : item.delivery.ok
            ? `<span class="pl-feedback-status pl-feedback-status-ok" title="${escapeHtml(deliveryStatusText(item.delivery))}">送信済み</span>`
            : `<span class="pl-feedback-status pl-feedback-status-fail" title="${escapeHtml(deliveryStatusText(item.delivery))}">送信失敗</span>`
        : "";
      const approximate = state.approximateIds.has(item.id)
        ? '<span class="pl-feedback-approx" title="ウィンドウサイズが変わったため、位置が近似になっています">≈</span>'
        : "";
      const exported = item.exported
        ? `<span class="pl-feedback-exported" title="${escapeHtml(`書き出し済み: ${item.exportedFileName || ""}`.trim())}">書き出し済み</span>`
        : "";
      return `
        <article class="pl-feedback-item${item.exported ? " pl-feedback-item-exported" : ""}" data-feedback-id="${escapeHtml(item.id)}" tabindex="-1">
          <span class="pl-feedback-num kind-${escapeHtml(kind)}">${num}</span>
          <div class="pl-feedback-body">
            <div class="pl-feedback-meta">${escapeHtml(item.reviewer || "(no name)")} ${delivery}${inboxStatusChip(item)}${exported}${approximate}</div>
            <div class="pl-feedback-text">${escapeHtml(item.comment || "")}</div>
          </div>
          <div class="pl-feedback-actions">
            ${(item.delivery?.ok === false || (item.delivery?.interrupted && item.delivery.target !== "slack-webhook")) && !item.localEdited && item.delivery.status !== 409 ? '<button type="button" data-pl-retry>再送</button>' : ""}
            <button type="button" data-pl-edit title="この端末のコメントを編集"${item.delivery?.pending ? " disabled" : ""}>編集</button>
            <button type="button" data-pl-delete title="この端末のコメントを削除"${item.delivery?.pending ? " disabled" : ""}>削除</button>
          </div>
        </article>
      `;
    })
    .join("");
  if (focusedId) feedbackListItem(focusedId)?.focus({ preventScroll: true });
}

// Matched by comparing dataset values, as a stored id is not safe to put in a
// selector unescaped.
function feedbackListItem(id) {
  return Array.from(getRoot().querySelectorAll("[data-feedback-id]")).find((node) => node.dataset.feedbackId === id);
}

// The display mode and the inbox status are applied to every committed marker
// here, so markers added or restored take them when the list is rendered. A
// comment finished in the inbox (#147) is hidden in 通常 and ドットだけ and
// grayed out in 全部. The marker of a comment still being written keeps its
// full look, so the chosen spot stays visible while the comment is typed.
function applyMarkerDisplay() {
  const statuses = state.inboxStatus?.statuses;
  state.feedback.forEach((item) => {
    const marker = state.feedbackMarkers.get(item.id);
    if (!marker) return;
    const finished = isFinished(item, statuses);
    marker.node.classList.toggle("pl-marker-dot", state.displayMode === "dots");
    marker.node.classList.toggle("pl-marker-done", finished && state.displayMode === "all");
    marker.node.hidden = finished && state.displayMode !== "all";
  });
}

// The inbox status next to the delivery status (#147), shown once a lookup has
// answered for the comment. An asked id missing from the answer was deleted in
// the inbox, or sent to another receiver.
function inboxStatusChip(item) {
  const lookup = state.inboxStatus;
  if (!lookup || !lookup.asked.has(item.id)) return "";
  const status = lookup.statuses.get(item.id);
  if (!status) return '<span class="pl-inbox-status pl-inbox-status-missing" title="受信箱で削除されたか、別の受信箱に送られています">受信箱に無い</span>';
  const finished = isFinished(item, lookup.statuses);
  return `<span class="pl-inbox-status${finished ? " pl-inbox-status-done" : ""}" title="受信箱の対応状況">受信箱: ${escapeHtml(FEEDBACK_STATUS_LABELS[status])}</span>`;
}

// Asks the receiver for the inbox status of the delivered comments (#147). It
// runs on load, when the panel opens and when the tab comes back, no more often
// than the lookup state allows (longer after failures), and stops for the page
// once the receiver has no lookup for it. Only the receiver delivery mode asks.
async function refreshInboxStatuses() {
  if (state.statusLookupInFlight || state.statusLookup.stopped || Date.now() < state.statusLookup.nextAt) return;
  if (state.options.deliveryMode !== "receiver") return;
  const url = statusLookupUrl(state.options.endpoint, window.location.href);
  const ids = statusLookupIds(state.feedback);
  if (!url || ids.length === 0) return;
  const root = getRoot();
  state.statusLookupInFlight = true;
  let httpStatus = 0;
  let statuses = null;
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.options.ingestKey) headers["X-PatchLoop-Ingest-Key"] = state.options.ingestKey;
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: state.options.projectId, ids })
    });
    httpStatus = response.status;
    if (response.ok) statuses = statusesFromAnswer(await response.json());
  } catch (error) {
    console.info("[PatchLoop] inbox status lookup failed", error);
  } finally {
    state.statusLookupInFlight = false;
  }
  // A re-init or destroy while the request was out leaves this answer behind.
  if (getRoot() !== root) return;
  const outcome = lookupOutcome(httpStatus, statuses);
  state.statusLookup = lookupAfter(state.statusLookup, outcome, Date.now());
  state.inboxStatus = outcome === "ok" ? { statuses, asked: new Set(ids) } : null;
  renderFeedbackList();
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") refreshInboxStatuses();
}

function deliveryStatusText(delivery) {
  if (!delivery) return "";
  if (delivery.pending) return "送信しています…";
  if (delivery.interrupted) return delivery.target === "slack-webhook"
    ? "送信が中断されました。Slack 側で内容を確認してください。再送すると重複する可能性があります。"
    : "送信が中断されたため、結果は未確認です。受信箱の内容を確認してから再送してください。";
  if (delivery.target === "download") {
    if (delivery.ok) return `downloaded ${delivery.fileName || ""}`.trim();
    return `download failed: ${delivery.error || "unknown error"}`;
  }
  if (delivery.target === "slack-webhook") {
    if (delivery.ok === null) return "Slack への送信を開始しました。ブラウザから送信結果は確認できません。";
    if (delivery.ok) return "Slack に送信しました。";
    return "Slack に送信できませんでした。送信先・設定を確認してください。";
  }
  if (delivery.ok) return "受信箱に送信しました。";
  if (delivery.status === 409) return "同じ ID が受信済みです。受信箱の内容を確認してください。";
  return "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。";
}

function renumberMarkers() {
  const ordered = state.feedback.slice().reverse();
  ordered.forEach((item, i) => {
    const marker = state.feedbackMarkers.get(item.id);
    if (marker && marker.label) {
      updateMarkerLabel(marker, item, i + 1);
    }
  });
}

function updateMarkerLabel(marker, item, number) {
  marker.label.textContent = String(number);
  const kind = item.target?.kind === "area" ? "範囲" : "点";
  marker.label.setAttribute("aria-label", `${kind}のフィードバック ${number}: ${truncateText(item.comment || "", 140)}`);
}

function handleListClick(event) {
  const itemEl = event.target.closest("[data-feedback-id]");
  if (!itemEl) return;
  const id = itemEl.dataset.feedbackId;
  if (event.target.closest("[data-pl-retry]")) {
    return retryFeedback(id);
  }
  if (event.target.closest("[data-pl-edit]")) {
    startEditFeedback(id);
    return;
  }
  if (event.target.closest("[data-pl-delete]")) {
    deleteFeedback(id);
  }
}

async function retryFeedback(id) {
  const root = getRoot();
  const item = state.feedback.find((entry) => entry.id === id);
  if (!item || item.delivery?.pending || item.localEdited) return;
  if (!shouldDeliverFeedback()) {
    showWidgetNotice("送信先・設定を確認してください。ファイル共有の場合は書き出しを使います。", true);
    return;
  }
  item.delivery = pendingDelivery();
  persistFeedbackList();
  renderFeedbackList();
  await deliverFeedback(item);
  if (getRoot() !== root) return;
  persistFeedbackList();
  renderFeedbackList();
  showWidgetNotice(deliveryStatusText(item.delivery), item.delivery.ok === false);
  getRoot()?.querySelector("[data-pl-collapse]")?.focus({ preventScroll: true });
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
  state.approximateIds.delete(id);
  persistFeedbackList();
  renumberMarkers();
  renderFeedbackList();
  if (state.editingId === id) {
    state.editingId = null;
    closeCommentForm();
  }
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
      if (document.activeElement !== marker.label) hideTooltip();
    });
  });
  marker.label.setAttribute("aria-describedby", "pl-feedback-tooltip");
  marker.label.addEventListener("focus", () => {
    const item = state.feedback.find((f) => f.id === feedbackId);
    if (!item) return;
    const rect = marker.label.getBoundingClientRect();
    showTooltip({ clientX: rect.right, clientY: rect.top }, item);
  });
  marker.label.addEventListener("blur", () => {
    if (!marker.node.matches(":hover")) hideTooltip();
  });
  marker.label.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    hideTooltip();
  });
}

// Activating a marker (click, Enter, Space) opens the panel on its comment: the
// way to read a dot-only marker on touch screens, and the way to its edit and
// delete actions from the page.
function bindMarkerActivation(marker, feedbackId) {
  marker.label.addEventListener("click", () => {
    if (state.active) return;
    expandPanel();
    feedbackListItem(feedbackId).focus();
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
  return pointFromClient(event.clientX, event.clientY, viewportMetrics());
}

// Snapshot of the DOM state the pure geometry/anchoring functions need.
function viewportMetrics() {
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight
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
    ...markerPosition(rect.pageLeftPx, rect.pageTopPx),
    width: `${rect.widthPx}px`,
    height: `${rect.heightPx}px`
  });
  const label = document.createElement("button");
  label.type = "button";
  label.textContent = "…";
  label.setAttribute("aria-label", "コメント入力中の範囲");
  area.append(label);
  document.body.append(area);
  return { node: area, label };
}

function getRoot() {
  return document.querySelector("[data-patchloop-root]");
}

function injectStyles() {
  if (document.querySelector("[data-patchloop-style]")) return;
  const style = document.createElement("style");
  style.dataset.patchloopStyle = "true";
  // The first three rules isolate the widget from the host page's CSS (#174).
  // Page rules on bare element names, * and ::before / ::after (header,
  // section, button, p, *::before, ...) would otherwise fill every property
  // the widget leaves unset. Top-level widget nodes drop to initial values, so
  // no page typography is inherited, except the lang-derived locale
  // (-webkit-locale) that all: initial would also clear and that picks the
  // Japanese glyphs. Their descendants and their ::before / ::after revert to
  // the browser defaults.
  // The reset is (0,1,0) ((0,1,1) for pseudo-elements) and comes first, so
  // every widget rule below must start with a .pl- class or a data-patchloop
  // attribute to win over it. The descendant reset is kept apart from the
  // :is() rule so that a browser without :is() still applies it.
  // Not covered: page rules of (0,1,1) or more (button:hover, textarea:focus,
  // section > header:first-child), !important, (0,1,0) attribute rules loaded
  // after init, other pseudo-elements (::placeholder, ::marker, ::selection),
  // and direction / unicode-bidi, which all does not reset. Full isolation
  // would need a shadow root.
  // A dot-only marker (#147) draws its dot as a bordered ::before box rather
  // than a background gradient: forced colors mode drops gradients but keeps
  // borders, in the user's colors, so the dot stays visible there.
  style.textContent = `
    .pl-root, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection] { all: initial; -webkit-locale: inherit; }
    .pl-root *, [data-patchloop-area] * { all: revert; }
    :is(.pl-root, .pl-root *, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-area] *, [data-patchloop-selection])::before, :is(.pl-root, .pl-root *, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-area] *, [data-patchloop-selection])::after { all: revert; }
    .pl-root, .pl-root * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: normal; }
    .pl-root [hidden], .pl-comment[hidden], .pl-tooltip[hidden], [data-patchloop-pin][hidden], [data-patchloop-area][hidden] { display: none !important; }
    .pl-root { position: fixed; z-index: 2147483000; color: #14211d; right: 20px; bottom: max(20px, env(safe-area-inset-bottom)); font-size: 14px; line-height: 1.5; text-align: left; }
    .pl-panel { position: absolute; right: 0; bottom: 0; width: min(400px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); background: #fff; border: 1px solid #d9e1dd; border-radius: 16px; box-shadow: 0 18px 65px rgba(20, 33, 29, 0.16); overflow: auto; overscroll-behavior: contain; }
    .pl-panel header { min-height: 64px; padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #edf1ee; }
    .pl-title { flex: 1; min-width: 0; font-size: 17px; font-weight: 750; order: -1; }
    .pl-handle { min-width: 42px; min-height: 36px; padding: 6px 10px; border: 0; background: #f2f6f3; cursor: pointer; font-size: 11px; color: #42584c; border-radius: 8px; font-weight: 600; }
    .pl-handle:hover { background: #f0f3ef; }
    .pl-handle.pl-mode-on { background: #b83d4d; color: #fff; }
    .pl-handle.pl-mode-on:hover { background: #9f3442; }
    .pl-mode { display: block; width: 100%; min-height: 44px; padding: 10px 16px; border-radius: 9px; border: 1px solid #0f7b63; background: #0f7b63; color: #fff; font-weight: 650; font-size: 13px; cursor: pointer; }
    .pl-mode[aria-pressed="true"] { background: #b83d4d; border-color: #b83d4d; }
    .pl-panel.pl-collapsed { width: auto; min-width: 152px; border-radius: 999px; overflow: hidden; background: #0f7b63; border-color: #0f7b63; }
    .pl-feedback-active .pl-panel.pl-collapsed { background: #b83d4d; border-color: #b83d4d; }
    .pl-panel.pl-collapsed header { padding: 0; min-height: 48px; border-bottom: 0; }
    .pl-panel.pl-collapsed .pl-title,
    .pl-panel.pl-collapsed .pl-mode { display: none; }
    .pl-panel.pl-collapsed .pl-panel-body { display: none; }
    .pl-panel p { margin: 0; color: #65716d; font-size: 12px; line-height: 1.7; }
    .pl-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 20px 18px; }
    .pl-actions button, .pl-form-actions button { min-height: 40px; border-radius: 8px; border: 1px solid #d9e1dd; background: #fff; color: #14211d; padding: 8px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .pl-actions [data-pl-download-all] { background: #0f7b63; border-color: #0f7b63; color: #fff; font-weight: 800; }
    .pl-actions [data-pl-download-all]:disabled { background: #cfd8d4; border-color: #cfd8d4; color: #fff; cursor: default; }
    .pl-form-actions button[type="submit"] { background: #0f7b63; border-color: #0f7b63; color: #fff; font-weight: 800; }
    .pl-delivery-settings { margin: 0 20px 20px; border-top: 1px solid #d9e1dd; padding-top: 14px; background: #fff; }
    .pl-delivery-settings summary { cursor: pointer; color: #65716d; font-weight: 600; font-size: 12px; }
    .pl-delivery-settings label { display: grid; gap: 5px; margin-top: 8px; color: #65716d; font-size: 11px; font-weight: 800; }
    .pl-delivery-settings input, .pl-delivery-settings select { width: 100%; min-height: 40px; border: 1px solid #d9e1dd; border-radius: 7px; background: #fff; color: #14211d; padding: 8px 10px; font: inherit; font-size: 12px; }
    .pl-feedback-list { max-height: min(320px, 40dvh); overflow-y: auto; padding: 0 20px 18px; display: grid; gap: 10px; overscroll-behavior: contain; }
    .pl-feedback-list-empty { margin: 0; color: #65716d; font-size: 12px; padding: 24px 12px !important; border: 1px dashed #d9e1dd; border-radius: 9px; text-align: center; }
    .pl-feedback-item { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 8px 10px; padding: 14px; border: 1px solid #e2e9e5; border-radius: 10px; background: #fff; align-items: start; }
    .pl-feedback-num { width: 24px; height: 24px; min-width: 24px; min-height: 24px; box-sizing: border-box; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 900; font-size: 11px; line-height: 1; }
    .pl-feedback-num.kind-point { background: #0f7b63; }
    .pl-feedback-num.kind-area { background: #b83d4d; }
    .pl-feedback-body { display: grid; gap: 4px; min-width: 0; }
    .pl-feedback-meta { color: #65716d; font-weight: 500; font-size: 10px; }
    .pl-feedback-text { color: #14211d; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
    .pl-feedback-actions { display: flex; gap: 8px; grid-column: 2; margin-top: 4px; }
    .pl-feedback-actions button { min-height: 32px; padding: 4px 10px; font-size: 11px; border-radius: 6px; border: 1px solid #d9e1dd; background: #fff; color: #14211d; cursor: pointer; font-weight: 500; }
    .pl-feedback-actions [data-pl-delete] { border-color: #b83d4d; color: #b83d4d; }
    .pl-feedback-status { font-weight: 900; }
    .pl-feedback-status-ok { color: #0f7b63; }
    .pl-feedback-status-fail { color: #b83d4d; }
    .pl-feedback-status-unknown { color: #65716d; }
    .pl-feedback-exported { color: #0f7b63; font-weight: 900; font-size: 10px; border: 1px solid #0f7b63; border-radius: 999px; padding: 1px 6px; margin-left: 2px; }
    .pl-feedback-item-exported { background: #f7f8f5; }
    .pl-tooltip { position: fixed; max-width: 280px; background: #14211d; color: #fff; padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; pointer-events: none; z-index: 2147483002; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.32); white-space: pre-wrap; word-break: break-word; }
    .pl-comment { position: fixed; z-index: 2147483001; width: min(360px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; overscroll-behavior: contain; display: grid; gap: 14px; padding: 22px; background: #fff; border: 1px solid #d9e1dd; border-radius: 14px; box-shadow: 0 18px 70px rgba(20, 33, 29, 0.22); }
    .pl-comment label { display: grid; gap: 6px; color: #42584c; font-size: 12px; font-weight: 600; }
    .pl-comment textarea, .pl-comment input { width: 100%; border: 1px solid #ccd9d1; border-radius: 8px; padding: 10px 12px; background: #fff; color: #14211d; font: inherit; font-size: 14px; line-height: 1.6; resize: vertical; }
    .pl-form-error { margin: 0; padding: 10px 12px; border-radius: 6px; color: #b83d4d; background: #fff0f2; font-size: 12px; font-weight: 600; }
    .pl-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .pl-pin { position: absolute; z-index: 2147482999; transform: translate(-50%, -50%); width: 30px; height: 30px; min-width: 30px; min-height: 30px; max-width: 30px; max-height: 30px; box-sizing: border-box; display: grid; place-items: center; padding: 0; line-height: 1; border-radius: 50%; border: 3px solid #fff; background: #b83d4d; color: #fff; font: 900 13px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); cursor: pointer; }
    .pl-selection { position: fixed; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; }
    .pl-area { position: absolute; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.16); }
    .pl-area button { position: absolute; top: 6px; left: 6px; width: 30px; height: 30px; min-width: 30px; min-height: 30px; padding: 0; box-sizing: border-box; display: grid; place-items: center; border-radius: 50%; border: 3px solid #fff; background: #b83d4d; color: #fff; font: 900 13px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); pointer-events: auto; cursor: pointer; }
    .pl-pin.pl-marker-dot, .pl-area.pl-marker-dot button { width: 24px; height: 24px; min-width: 24px; min-height: 24px; max-width: 24px; max-height: 24px; border: 0; background: transparent; box-shadow: none; font-size: 0; }
    .pl-pin.pl-marker-dot::before, .pl-area.pl-marker-dot button::before { content: ""; width: 13px; height: 13px; box-sizing: border-box; border: 1.5px solid #fff; border-radius: 50%; background: #b83d4d; }
    .pl-area.pl-marker-dot button { top: 9px; left: 9px; }
    .pl-pin.pl-marker-done, .pl-area.pl-marker-done button { background: #6b7570; border-style: dashed; }
    .pl-area.pl-marker-done { border-color: #6b7570; border-style: dashed; background: rgba(107, 117, 112, 0.10); }
    .pl-area.pl-marker-dot:not(:hover):not(:focus-within) { border-color: transparent; background: transparent; box-shadow: none; outline: none !important; }
    .pl-feedback-active [data-patchloop-pin], .pl-feedback-active .pl-area button { pointer-events: none; }
    .pl-target-highlight { outline: 2px dashed #d1495b; outline-offset: 2px; }
    .pl-marker-approx { outline: 3px dashed #f2a33c !important; outline-offset: 2px; }
    .pl-feedback-approx { color: #986000; font-weight: 900; cursor: help; margin-left: 2px; }
    .pl-feedback-active, .pl-feedback-active * { cursor: crosshair !important; }
    .pl-root :focus-visible, .pl-pin:focus-visible, .pl-area button:focus-visible { outline: 3px solid #168565; outline-offset: 3px; }
    .pl-capture-guide { position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: space-between; gap: 16px; width: max-content; max-width: calc(100vw - 24px); padding: 12px 16px; background: #14211d; color: #fff; border-radius: 12px; box-shadow: 0 10px 40px #14211d33; font-size: 12px; }
    .pl-capture-guide small { display: block; font-size: 10px; color: #d1dfd7; margin-top: 3px; }
    .pl-capture-guide button { border: 1px solid #65716d; border-radius: 7px; background: #fff; color: #14211d; min-height: 36px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
    .pl-feedback-active [data-patchloop-root], .pl-feedback-active [data-patchloop-root] * { cursor: auto !important; }
    .pl-root button:disabled { cursor: wait; opacity: .55; }
    .pl-panel.pl-collapsed .pl-handle { width: 100%; padding: 12px 22px; min-height: 48px; border-radius: 999px; color: #fff; background: #0f7b63; font-size: 13px; }
    .pl-panel.pl-collapsed .pl-handle.pl-mode-on { background: #b83d4d; }
    .pl-panel-body { padding-top: 18px; }
    .pl-compose { padding: 0 20px 18px; }
    .pl-compose p { padding: 10px 0 0; font-size: 11px; }
    .pl-list-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 0 20px 10px; font-size: 11px; color: #53695d; }
    .pl-list-heading span { border-radius: 5px; padding: 1px 7px; background: #edf4ef; font-variant-numeric: tabular-nums; }
    .pl-display-mode { margin: 0 20px 12px; padding: 0; border: 0; min-width: 0; }
    .pl-display-mode legend { padding: 0 0 4px; font-size: 11px; font-weight: 600; color: #53695d; }
    .pl-display-mode label { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin-right: 16px; color: #14211d; font-size: 12px; cursor: pointer; }
    .pl-display-mode input { width: 16px; height: 16px; margin: 0; accent-color: #0f7b63; cursor: pointer; }
    .pl-feedback-item:focus { outline: 3px solid #168565; outline-offset: -3px; }
    .pl-actions [data-pl-clear] { border: 0; color: #65716d; font-size: 10px; padding: 5px 0; min-height: 32px; }
    .pl-actions [data-pl-download-again] { font-size: 11px; }
    .pl-panel .pl-notice { margin: 0 20px 16px; padding: 10px 12px; border-radius: 8px; background: #edf6ef; color: #245840; font-size: 11px; }
    .pl-panel .pl-notice[data-state="error"] { background: #fff0f2; color: #a32f45; }
    .pl-form-heading { display: grid; gap: 4px; }
    .pl-form-heading strong { font-size: 16px; font-weight: 700; }
    .pl-form-heading span { color: #65716d; font-size: 11px; }
    .pl-comment .pl-screenshot-option { display: flex; align-items: center; gap: 8px; font-weight: 500; }
    .pl-comment input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: #0f7b63; }
    .pl-comment .pl-capture-note, .pl-comment .pl-edit-note { margin: -5px 0 0; font-size: 10px; line-height: 1.6; color: #65716d; }
    .pl-comment .pl-edit-note { padding: 10px; background: #fff8e7; color: #785011; border-radius: 6px; }
    .pl-keyboard-hint { color: #65716d; font-size: 10px; text-align: right; }
    .pl-feedback-status { display: inline-block; margin-left: 5px; font-weight: 600; }
    .pl-inbox-status { display: inline-block; margin-left: 5px; padding: 0 6px; border: 1px solid #d9e1dd; border-radius: 999px; color: #42584c; font-weight: 600; }
    .pl-inbox-status-done { border-color: #0f7b63; color: #0f7b63; }
    .pl-inbox-status-missing { border-color: #e2c48a; color: #785011; }
    @media (max-width: 480px) {
      .pl-root { right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); }
      .pl-panel { width: calc(100vw - 24px); }
      .pl-comment { padding: 18px; }
      .pl-comment textarea, .pl-comment input { font-size: 16px; }
      .pl-feedback-list { max-height: 28dvh; }
    }
    @media (prefers-reduced-motion: reduce) { .pl-root *, .pl-pin, .pl-area { transition: none !important; scroll-behavior: auto !important; } }

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
