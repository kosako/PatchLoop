import { pointFromClient, rectFromPoints, rectContainsArea, pointFromStoredTarget, rectFromStoredArea, storedPointAt, storedAreaFields, numberOrNull } from "./geometry.js";
import { pointAnchorOffsets, areaAnchorOffsets, geometryFromAnchor, viewportDiffersFromCreation } from "./anchoring.js";
import { selectorFor, textFor } from "./selector.js";
import { resolveSourceContext } from "./source-context.js";
import { applyPageUrlRule, applySourceContextUrlRule, normalizeKeepQueryParams } from "./url.js";
import { exceedsFieldLimit, normalizeMaxFieldLength } from "./field-limit.js";
import { normalizeDeliveryMode } from "./delivery-mode.js";
import { DEFAULTS, state } from "./state.js";
import { buildPayload, buildRevision } from "./payload.js";
import { uncapturedTouching } from "./screenshot.js";
import { WIDGET_CSS } from "./styles.js";
import { statusLookupUrl, statusLookupIds, statusesFromAnswer, isFinished, initialLookupState, lookupOutcome, lookupAfter } from "./inbox-status.js";
import { answeredDelivery, canRetry, deliveryBadge, deliveryFailed, deliveryStatusText, hasLeftDevice, interruptedDelivery, isDelivering, isLocallyEdited, pendingAge, receiverHasCopy, refusedAsIs, tooLongToSendText, unansweredDelivery } from "./delivery-state.js";
import { loadStoredReviewer, saveReviewer, loadDisplayMode, saveDisplayMode, loadLauncher, saveLauncher, persistFeedbackList, loadPersistedFeedback, clearPersistedFeedback, loadOtherPagesFeedback, saveOtherPageFeedback, bindFeedbackScope, isDemoFeedbackKey, isOwnFeedbackKey, syncPersistedFeedback } from "./persistence.js";
import { safeFilePart, truncateText, present, escapeHtml, slackEscape, formatSlackCode, formatSlackLink, formatViewport, formatTarget, formatCount, FEEDBACK_STATUS_LABELS } from "../../shared/format.js";
import { EXPORT_BUNDLE_VERSION } from "../../shared/versions.js";
import { EXPORT_BUNDLE_KIND } from "../../shared/contract.js";
import { toWireFeedback } from "../../shared/local-only.js";

// The receiver's answer is awaited this long. A delivery another tab of the
// page started is taken as cut off only once it and a margin are over (#139).
const FETCH_TIMEOUT_MS = 15000;
const STALE_PENDING_MS = FETCH_TIMEOUT_MS + 5000;
// The most of a refusal's body read for why: the receiver's error is short,
// and a longer body is not read on (#152).
const MAX_ANSWER_BYTES = 8192;
let pendingInit = null;
// The launcher chosen on this page (#211), kept over a re-init even where
// storage cannot keep it; null until the viewer chooses.
let launcherChosen = null;
const captureEvents = typeof window.PointerEvent === "function"
  ? ["pointerdown", "pointermove", "pointerup"]
  : ["mousedown", "mousemove", "mouseup"];
// What may move content under the markers (#213): any scroll (it does not
// bubble, so it is caught on the way down), a wheel, the end of a drag and a
// key; a move counts only while a button is held (see followDrag).
const FOLLOW_EVENTS = ["scroll", "wheel", captureEvents[2], "keyup"];

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
  cancelMarkerFollow();
  window.clearTimeout(state.missingRetryTimer);
  state.active = false;
  document.documentElement.classList.remove("pl-feedback-active");
  state.drag = null;
  state.pendingTarget = null;
  state.editingId = null;
  state.commentReturnFocus = null;
  removeSelectionBox();
  // Before the options change: saved under the scope they were made in.
  abandonDeliveries();
  state.options = { ...DEFAULTS, ...options };
  state.options.reviewer = initialReviewer(state.options);
  // Resolved once here (option first, meta tags as fallback) so every payload
  // built later carries the same provenance without re-reading the DOM.
  state.options.sourceContext = resolveSourceContext(state.options.sourceContext, document);
  state.options.keepQueryParams = normalizeKeepQueryParams(state.options.keepQueryParams);
  state.options.maxFieldLength = normalizeMaxFieldLength(state.options.maxFieldLength);
  state.options.deliveryMode = normalizeDeliveryMode(state.options.deliveryMode);
  // Its URLs leave under page.url's rule (#122).
  applySourceContextUrlRule(state.options.sourceContext, state.options.keepQueryParams);
  state.displayMode = loadDisplayMode();
  state.launcher = launcherChosen ?? loadLauncher();
  // Before anything renders: the panel counts the other pages against it.
  bindFeedbackScope();
  state.otherPages = null;
  resetInboxStatus();
  injectStyles();
  renderShell();
  bindGlobalCapture();
  restorePersistedFeedback();
  // Restored markers inside a box scrolled away are hidden from the start (#213).
  scheduleMarkerFollow();
  applyCollapseState();
  renderFeedbackList();
  refreshInboxStatuses();
  scheduleMissingRetry();
  return api;
}

function destroy() {
  cancelPendingInit();
  abandonDeliveries();
  document.documentElement.classList.remove("pl-feedback-active");
  document.querySelector("[data-patchloop-style]")?.remove();
  document.removeEventListener(captureEvents[0], handleDocumentMouseDown, true);
  document.removeEventListener(captureEvents[1], handleDocumentMouseMove, true);
  document.removeEventListener(captureEvents[2], handleDocumentMouseUp, true);
  document.removeEventListener("pointercancel", cancelCaptureDrag, true);
  document.removeEventListener("keydown", handleCaptureKeydown, true);
  document.removeEventListener("click", suppressDocumentClick, true);
  window.removeEventListener("resize", handleWindowResize);
  FOLLOW_EVENTS.forEach((type) => document.removeEventListener(type, scheduleMarkerFollow, true));
  document.removeEventListener(captureEvents[1], followDrag, true);
  cancelMarkerFollow();
  window.visualViewport?.removeEventListener("resize", positionVisibleCommentForm);
  window.visualViewport?.removeEventListener("scroll", positionVisibleCommentForm);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("storage", handleStorageChange);
  window.removeEventListener("pagehide", abandonDeliveries);
  window.removeEventListener("pageshow", handlePageShow);
  window.clearTimeout(state.otherPagesTimer);
  window.clearTimeout(state.resizeTimer);
  window.clearTimeout(state.missingRetryTimer);
  window.clearTimeout(state.pendingCheckTimer);
  resetInboxStatus();
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
  root.className = "pl-root";
  root.innerHTML = `
    <section class="pl-panel pl-collapsed" data-pl-panel aria-label="PatchLoop フィードバック">
      <header>
        <button type="button" class="pl-handle" data-pl-collapse aria-expanded="false" title="フィードバックを開く">フィードバック</button>
        <button type="button" class="pl-tuck" data-pl-tuck aria-label="フィードバックのボタンを右端にしまう" title="右端にしまう">›</button>
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
        <p class="pl-other-pages" data-pl-other-pages hidden></p>
        ${renderDeliverySettings()}
      </div>
    </section>
    <button type="button" class="pl-tab" data-pl-tab aria-label="フィードバックのボタンを出す" title="フィードバックのボタンを出す" hidden>‹</button>
    <div class="pl-capture-guide" data-pl-capture-guide hidden><span>場所をクリック・タップして選択<small>Tab + Enter でも選べます</small></span><button type="button" data-pl-stop-capture>終了</button></div>
    <div class="pl-tooltip" id="pl-feedback-tooltip" role="tooltip" data-pl-tooltip hidden></div>
    <form class="pl-comment" data-pl-comment novalidate hidden>
      <div class="pl-form-heading"><strong data-pl-form-title>コメントを追加</strong><span>気づいたことを、ひとつずつ。</span></div>
      <div class="pl-field">
        <label>
          コメント
          <textarea data-pl-comment-text rows="4" placeholder="どこを、どう変えるとよくなりますか？" required aria-describedby="pl-form-error pl-comment-count pl-uncaptured-hint"></textarea>
        </label>
        <small class="pl-field-count" id="pl-comment-count" data-pl-comment-count hidden></small>
      </div>
      <div class="pl-field">
        <label>
          投稿者
          <input data-pl-reviewer value="${escapeHtml(state.options.reviewer)}" placeholder="表示名" required aria-describedby="pl-form-error pl-reviewer-count" />
        </label>
        <small class="pl-field-count" id="pl-reviewer-count" data-pl-reviewer-count hidden></small>
      </div>
      <label class="pl-screenshot-option" data-pl-screenshot-field><input type="checkbox" data-pl-include-screenshot${state.options.captureScreenshot ? " checked" : ""} />画面画像を含める</label>
      <p class="pl-capture-note" data-pl-capture-note>画像には画面外の内容が含まれる場合があります。機密情報のあるページでは外してください。</p>
      <p class="pl-uncaptured-hint" id="pl-uncaptured-hint" data-pl-uncaptured-hint hidden></p>
      <p class="pl-form-error" id="pl-form-error" data-pl-form-error role="alert" hidden></p>
      <p class="pl-edit-note" data-pl-edit-note hidden></p>
      <div class="pl-form-actions">
        <button type="button" data-pl-cancel>キャンセル</button>
        <button type="submit" data-pl-submit>コメントを送る</button>
      </div>
      <small class="pl-keyboard-hint">⌘ / Ctrl + Enter で確定 · Esc でキャンセル</small>
    </form>
  `;

  document.body.append(root);

  root.querySelector("[data-pl-collapse]").addEventListener("click", toggleCollapse);
  root.querySelector("[data-pl-tuck]").addEventListener("click", () => setLauncher("tab"));
  root.querySelector("[data-pl-tab]").addEventListener("click", () => setLauncher("button"));
  root.querySelector("[data-pl-mode]").addEventListener("click", toggleFeedbackMode);
  root.querySelector("[data-pl-stop-capture]")?.addEventListener("click", () => setFeedbackMode(false));
  root.querySelector("[data-pl-download-all]").addEventListener("click", downloadUnsentFeedback);
  root.querySelector("[data-pl-download-again]")?.addEventListener("click", downloadAllFeedback);
  root.querySelector("[data-pl-clear]").addEventListener("click", () => {
    if (state.feedback.some(isDelivering)) return;
    if (window.confirm("この端末に保存したコメントをすべて消します。送信先の内容は削除されません。続けますか？")) clearPins();
  });
  root.querySelector("[data-pl-cancel]").addEventListener("click", cancelPendingComment);
  root.querySelector("[data-pl-comment]").addEventListener("submit", submitComment);
  root.querySelector("[data-pl-comment]").addEventListener("keydown", handleCommentKeydown);
  root.querySelector("[data-pl-include-screenshot]").addEventListener("change", () => syncUncapturedHint(root.querySelector("[data-pl-comment]")));
  root.querySelector("[data-pl-reviewer]").addEventListener("input", () => handleCommentInput(root.querySelector("[data-pl-comment]")));
  root.querySelector("[data-pl-comment-text]").addEventListener("input", () => handleCommentInput(root.querySelector("[data-pl-comment]")));
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
  FOLLOW_EVENTS.forEach((type) => {
    document.removeEventListener(type, scheduleMarkerFollow, true);
    document.addEventListener(type, scheduleMarkerFollow, { capture: true, passive: true });
  });
  document.removeEventListener(captureEvents[1], followDrag, true);
  document.addEventListener(captureEvents[1], followDrag, { capture: true, passive: true });
  window.visualViewport?.removeEventListener("resize", positionVisibleCommentForm);
  window.visualViewport?.addEventListener("resize", positionVisibleCommentForm);
  window.visualViewport?.removeEventListener("scroll", positionVisibleCommentForm);
  window.visualViewport?.addEventListener("scroll", positionVisibleCommentForm);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("storage", handleStorageChange);
  window.addEventListener("storage", handleStorageChange);
  window.removeEventListener("pagehide", abandonDeliveries);
  window.addEventListener("pagehide", abandonDeliveries);
  window.removeEventListener("pageshow", handlePageShow);
  window.addEventListener("pageshow", handlePageShow);
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
  const metrics = viewportMetrics();
  const rect = rectFromPoints(start, end, metrics);
  const target = state.drag.keyboard ? state.drag.target : document.elementFromPoint(start.clientX, start.clientY) || state.drag.target;

  discardPendingMarker();
  // A new capture supersedes an interrupted edit; a stale editingId would
  // route the submit into the edit branch and silently overwrite that item.
  state.editingId = null;

  let marker;
  if (state.drag.isDragging) {
    marker = addArea(rect);
    const areaAnchor = buildAreaAnchor(target, rect, end);
    const { point, area } = storedAreaFields(rect, metrics);
    state.pendingTarget = {
      kind: "area",
      ...point,
      area,
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
  ["[data-pl-collapse]", "[data-pl-tuck]", "[data-pl-tab]"].forEach((selector) => root.querySelector(selector)?.classList.toggle("pl-mode-on", state.active));
  const modeBtn = root.querySelector("[data-pl-mode]");
  modeBtn.textContent = state.active ? "場所の選択を終了" : "コメントを追加";
  modeBtn.setAttribute("aria-pressed", String(state.active));
  const guide = root.querySelector("[data-pl-capture-guide]");
  const focusInGuide = guide?.contains(document.activeElement);
  const focusInPanelBody = document.activeElement === modeBtn || root.querySelector("[data-pl-body]")?.contains(document.activeElement);
  const panel = root.querySelector("[data-pl-panel]");
  const focusInPanel = panel?.contains(document.activeElement);
  if (guide) guide.hidden = !state.active;
  if (state.active) {
    state.collapsed = true;
    applyCollapseState();
    // Tucked (#211), the whole panel goes, its header with the button too.
    if (focusInPanelBody || (panel?.hidden && focusInPanel)) root.querySelector("[data-pl-stop-capture]")?.focus({ preventScroll: true });
  } else if (focusInGuide) {
    focusLauncher();
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
  if (editNote) {
    editNote.hidden = !editing;
    const edited = editing ? state.feedback.find((item) => item.id === state.editingId) : null;
    editNote.textContent = edited && hasLeftDevice(edited)
      ? "書き出し済みか送信済みのコメントです。変更は元のコメントの修正版（新しいコメント）として届けます。受け取り済みの元のコメントや作成済みの Issue は変わりません。"
      : "編集はこの端末に保存されます。";
  }
  const screenshotField = form.querySelector("[data-pl-screenshot-field]");
  const captureNote = form.querySelector("[data-pl-capture-note]");
  if (screenshotField) screenshotField.hidden = editing || !state.options.captureScreenshot;
  if (captureNote) captureNote.hidden = editing || !state.options.captureScreenshot;
  const screenshotInput = form.querySelector("[data-pl-include-screenshot]");
  if (screenshotInput) screenshotInput.checked = state.options.captureScreenshot;
  // Before anything is sent, point the reviewer at elements the screenshot will
  // not show where they are pointing (#148), so they can describe what they see.
  const touching = !editing && state.options.captureScreenshot && state.pendingTarget ? uncapturedTouching(state.pendingTarget) : [];
  state.uncapturedHint = touching.length > 0 ? uncapturedHintText(touching) : "";
  syncUncapturedHint(form);
  clearFormError(form);
  const commentEl = form.querySelector("[data-pl-comment-text]");
  const reviewerEl = form.querySelector("[data-pl-reviewer]");
  commentEl.value = options.comment != null ? options.comment : "";
  if (options.reviewer != null) {
    reviewerEl.value = options.reviewer;
  }
  // A saved comment or name may already be too long (#196).
  const tooLong = syncFieldLimit(form);
  if (tooLong) showFormError(form, fieldTooLongText(tooLong));
  positionCommentForm(form, point);
  commentEl.focus({ preventScroll: true });
}

// The note is about the screenshot, so it follows the "画面画像を含める" box.
function syncUncapturedHint(form) {
  const hint = form.querySelector("[data-pl-uncaptured-hint]");
  const included = form.querySelector("[data-pl-include-screenshot]").checked;
  const text = included ? state.uncapturedHint : "";
  hint.hidden = !text;
  hint.textContent = text;
}

function uncapturedHintText(touching) {
  const names = [...new Set(touching.map((region) => truncateText(region.tag, 40)))];
  const shown = names.slice(0, 3).join("、");
  return `選んだ場所に、画面画像に写らない要素（${shown}${names.length > 3 ? " など" : ""}）が重なっているかもしれません。見えている内容をコメントに書き添えてください。`;
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
  focusLauncher();
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

  const previous = [state.options.deliveryMode, state.options.endpoint];
  if (mode) state.options.deliveryMode = mode;
  if (endpoint != null) state.options.endpoint = endpoint.trim();
  if (slackWebhookUrl != null) state.options.slackWebhookUrl = slackWebhookUrl.trim();
  // Statuses belong to the receiver they were asked of (#147): another
  // destination shows everything again until it is asked.
  if (state.options.deliveryMode !== previous[0] || state.options.endpoint !== previous[1]) {
    resetInboxStatus();
    renderFeedbackList();
  }
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

const LIMITED_FIELDS = [
  { input: "[data-pl-comment-text]", count: "[data-pl-comment-count]", name: "コメント" },
  { input: "[data-pl-reviewer]", count: "[data-pl-reviewer-count]", name: "投稿者名" }
];

// Typing clears the form's error, except that a comment or name longer than
// the receiver takes says so while it is (#196). The alert is set when it
// changes, not on every key, so a screen reader reads it once; the count
// under the field follows the typing.
function handleCommentInput(form) {
  const tooLong = syncFieldLimit(form);
  if (!tooLong) {
    clearFormError(form);
    return;
  }
  const message = fieldTooLongText(tooLong);
  const errorEl = form.querySelector("[data-pl-form-error]");
  if (errorEl.hidden || errorEl.textContent !== message) showFormError(form, message);
}

// Marks the fields longer than state.options.maxFieldLength, as saved (trimmed),
// with their length under them, and returns the first of them, or null. The
// length is beside the label, not in it, so it is not part of the field's name.
function syncFieldLimit(form) {
  const limit = state.options.maxFieldLength;
  let first = null;
  for (const field of LIMITED_FIELDS) {
    const input = form.querySelector(field.input);
    const count = form.querySelector(field.count);
    const length = input.value.trim().length;
    const tooLong = length > limit;
    if (tooLong) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    count.hidden = !tooLong;
    count.textContent = tooLong ? `${formatCount(length)} / ${formatCount(limit)} 文字` : "";
    if (tooLong && !first) first = field;
  }
  return first;
}

function fieldTooLongText(field) {
  return `${field.name}が長すぎます。${formatCount(state.options.maxFieldLength)} 文字以内にしてください。`;
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
  // The receiver would refuse it (#196), so it is neither listed nor sent.
  const tooLong = syncFieldLimit(form);
  if (tooLong) {
    showFormError(form, fieldTooLongText(tooLong));
    form.querySelector(tooLong.input).focus();
    return;
  }
  clearFormError(form);

  if (state.editingId) {
    // Another tab may have exported, revised or deleted it meanwhile (#139):
    // decide on the current state. A deletion closed the form and said so.
    syncFeedbackFromOtherTab();
    if (!state.editingId) return;
    const target = state.feedback.find((item) => item.id === state.editingId);
    const changed = target && (target.comment !== comment || target.reviewer !== reviewer);
    if (target && hasLeftDevice(target)) {
      if (!changed && !isLocallyEdited(target)) {
        state.editingId = null;
        closeCommentForm();
        showWidgetNotice("変更はありません。");
        return;
      }
      // What left this device is not rewritten: the edit goes as a revision
      // (#121). An earlier local change that never left goes with it.
      saveReviewer(reviewer);
      state.editingId = null;
      await commitFeedback(buildRevision(target, comment, reviewer), root, target);
      return;
    }
    if (target) {
      target.comment = comment;
      target.reviewer = reviewer;
      saveReviewer(reviewer);
      saveFeedbackList();
      renumberMarkers();
      renderFeedbackList();
      // Deleted in another tab meanwhile: the deletion won, as the notice says.
      if (!state.feedback.includes(target)) return;
    }
    state.editingId = null;
    closeCommentForm();
    showWidgetNotice("変更をこの端末に保存しました。");
    return;
  }

  if (!state.pendingTarget) return;

  saveReviewer(reviewer);
  const includeScreenshot = form.querySelector("[data-pl-include-screenshot]")?.checked ?? state.options.captureScreenshot;
  // #155: record the target as of confirming, like environment.viewport and the
  // screenshot: the reviewer may have scrolled since choosing the spot.
  const placement = storedPlacement(state.pendingTarget);
  if (placement) refreshTargetCoordinates(state.pendingTarget, placement);
  await commitFeedback(buildPayload(comment, reviewer, state.pendingTarget, includeScreenshot), root);
}

// Lists, saves, announces and delivers a new comment, or the revision of one
// that has left this device (#121), which takes the original's place in the
// list and on the page.
async function commitFeedback(payload, root, replacing = null) {
  const delivering = shouldDeliverFeedback();
  if (delivering) {
    payload.delivery = pendingDelivery();
    state.deliveringIds.add(payload.id);
  }
  if (replacing) {
    replaceFeedback(replacing, payload);
  } else {
    state.feedback.unshift(payload);
    finalizePendingMarker(payload);
  }
  saveFeedbackList();
  renderFeedbackList();
  expandPanel();
  closeCommentForm();

  document.dispatchEvent(new CustomEvent("patchloop:feedback", { detail: payload }));

  if (typeof state.options.onSubmit === "function") {
    // A patchloop:feedback listener may have re-initialized with a narrower rule.
    applyPageUrlRule(payload, state.options.keepQueryParams);
    try {
      Promise.resolve(state.options.onSubmit(payload)).catch(reportSubmitCallbackError);
    } catch (error) {
      reportSubmitCallbackError(error);
    }
  }

  if (delivering) {
    if (!(await deliverFeedback(payload)) || getRoot() !== root) return;
    saveFeedbackList();
    renderFeedbackList();
    showWidgetNotice(deliveryStatusText(payload.delivery, state.options.maxFieldLength), deliveryFailed(payload.delivery));
  } else if (state.options.deliveryMode === "download") {
    showWidgetNotice(replacing ? "変更を元のコメントの修正版として保存しました。「未送信を書き出す」から共有できます。" : "コメントを保存しました。「未送信を書き出す」から共有できます。");
  } else {
    showWidgetNotice(replacing ? "変更を元のコメントの修正版としてこの端末に保存しました。外部には送信していません。" : "コメントをこの端末に保存しました。外部には送信していません。");
  }
}

function replaceFeedback(original, revision) {
  const index = state.feedback.indexOf(original);
  if (index === -1) state.feedback.unshift(revision);
  else state.feedback.splice(index, 1, revision);
  state.feedbackMarkers.get(original.id)?.node?.remove();
  state.feedbackMarkers.delete(original.id);
  state.approximateIds.delete(original.id);
  addCommittedMarker(revision);
  renumberMarkers();
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
  let request;
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.options.ingestKey) {
      headers["X-PatchLoop-Ingest-Key"] = state.options.ingestKey;
    }
    request = { method: "POST", headers, body: JSON.stringify(toWireFeedback(payload)) };
    // What fetch refuses before anything is sent (the endpoint, a header, the
    // body) is refused here first: the comment surely has not left (#152).
    new Request(new URL(state.options.endpoint, document.baseURI), request);
  } catch (error) {
    return logDelivery(payload, { ok: false, error: error.message });
  }
  try {
    return logDelivery(payload, await fetchWithTimeout(state.options.endpoint, request, readAnswer));
  } catch (error) {
    return logDelivery(payload, unansweredDelivery(error));
  }
}

// The receiver's answer, with why it refused (#152). Its body is read within
// the timeout too; one that cannot be read, or is too long, leaves the status
// alone.
async function readAnswer(response) {
  let body = null;
  if (!response.ok) {
    try {
      body = JSON.parse(await readAnswerText(response));
    } catch (_) {
      // No reason to show: the status says what it can.
    }
  }
  return answeredDelivery(response.ok, response.status, body);
}

// The body as text, given up past MAX_ANSWER_BYTES.
async function readAnswerText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_ANSWER_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error("answer too long");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function logDelivery(payload, delivery) {
  console.info("[PatchLoop] delivery", payload.id, delivery);
  return delivery;
}

// read runs within the timeout too, so a body that stalls after the headers
// is aborted as well.
async function fetchWithTimeout(url, options, read = (response) => response) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await read(await fetch(url, { ...options, signal: controller.signal }));
  } finally {
    window.clearTimeout(timer);
  }
}

function restorePersistedFeedback() {
  removeCommittedMarkers();
  state.feedbackMarkers.clear();
  // Noted again as the markers are made from the comments restored (#200).
  state.approximateIds.clear();
  state.feedback = [];

  if (!state.options.persistFeedback) return;

  const stored = loadPersistedFeedback();
  if (!stored.length) return;

  state.feedback = stored;
  settlePendingDeliveries();
  restoreFeedbackMarkers();
  saveFeedbackList();
}

// A delivery saved as pending is another tab's (#139): a tab saves its own as
// interrupted when it stops waiting for them (abandonDeliveries). One started
// less than a fetch timeout ago stays pending and is checked again when it
// would have ended, by which time that tab has saved the result; an older one
// was cut off (the tab crashed), as is one saved before deliveries carried
// startedAt. A start ahead of this clock (the clock was set back) counts from
// when this tab first saw the delivery. Returns whether any changed.
function settlePendingDeliveries() {
  window.clearTimeout(state.pendingCheckTimer);
  const now = Date.now();
  // A clock set back later does not move this one.
  const monotonicNow = window.performance?.now?.() ?? now;
  const seenAt = new Map();
  let changed = false;
  let recheckIn = Infinity;
  state.feedback.forEach((item) => {
    if (!isDelivering(item) || state.deliveringIds.has(item.id)) return;
    seenAt.set(item.id, state.pendingSeenAt.get(item.id) ?? monotonicNow);
    const age = pendingAge(item.delivery.startedAt, now, seenAt.get(item.id), monotonicNow);
    if (age < STALE_PENDING_MS) {
      recheckIn = Math.min(recheckIn, STALE_PENDING_MS - age);
      return;
    }
    item.delivery = interruptedDelivery(item.delivery);
    changed = true;
  });
  state.pendingSeenAt = seenAt;
  if (recheckIn !== Infinity) state.pendingCheckTimer = window.setTimeout(recheckPendingDeliveries, recheckIn);
  return changed;
}

// Reads the saved list first: the other tab's result may be saved already,
// its storage event still on the way.
function recheckPendingDeliveries() {
  if (!getRoot() || !syncFeedbackFromOtherTab()) return;
  saveFeedbackList();
  renderFeedbackList();
}

// The deliveries in flight no longer report back once the page goes away
// (pagehide: closed, reloaded or left) or the widget is destroyed or
// re-initialized, so they are saved as interrupted, and other tabs and the
// next load show them so at once (#139).
function abandonDeliveries() {
  const abandoned = state.feedback.filter((item) => state.deliveringIds.has(item.id) && isDelivering(item));
  state.deliveringIds = new Set();
  if (abandoned.length === 0) return;
  abandoned.forEach((item) => {
    item.delivery = interruptedDelivery(item.delivery);
  });
  saveFeedbackList();
  // Shown so when the page comes back from the back/forward cache.
  renderFeedbackList();
}

// Back from the back/forward cache: what other tabs saved meanwhile.
function handlePageShow(event) {
  if (event.persisted) syncFeedbackFromOtherTab();
}

function shouldDeliverFeedback() {
  if (state.options.deliveryMode === "none") return false;
  // Download mode no longer ships per comment; the reviewer exports the
  // unsent batch on demand via the panel button.
  if (state.options.deliveryMode === "download") return false;
  if (state.options.deliveryMode === "slack-webhook") return Boolean(state.options.slackWebhookUrl);
  return Boolean(state.options.endpoint);
}

// Sends the comment and settles its delivery state, unless this tab gave the
// delivery up meanwhile (abandonDeliveries: the page went away, or the widget
// was destroyed or re-initialized): it was saved as interrupted then, and
// another tab may have retried it since (#139). Returns whether it settled.
async function deliverFeedback(payload) {
  const deliveringIds = state.deliveringIds;
  deliveringIds.add(payload.id);
  applyPageUrlRule(payload, state.options.keepQueryParams);
  // Checked again as it leaves, like page.url (#196): a patchloop:feedback
  // listener or onSubmit may have changed it, or re-initialized with a lower
  // limit. It stays here as not sent, to be shortened and resent.
  if (exceedsFieldLimit(payload)) {
    deliveringIds.delete(payload.id);
    payload.delivery = { ok: false, tooLong: true, target: pendingDelivery().target };
    return true;
  }
  const sent = { comment: payload.comment, reviewer: payload.reviewer };
  let delivery;
  try {
    delivery = await (state.options.deliveryMode === "slack-webhook" ? postSlackWebhook(payload) : postFeedback(payload));
  } finally {
    deliveringIds.delete(payload.id);
  }
  if (deliveringIds !== state.deliveringIds) return false;
  // The text that went out stays with the result: an edit another tab saved
  // meanwhile then shows as a local change, whichever text the merge keeps.
  // With a refusal of the comment as it is, it tells whether the text has
  // changed since, so it may go again (#152).
  payload.delivery = receiverHasCopy(delivery) || refusedAsIs(delivery) ? { ...delivery, sent } : delivery;
  return true;
}

function pendingDelivery() {
  return { pending: true, target: state.options.deliveryMode === "slack-webhook" ? "slack-webhook" : "receiver", startedAt: Date.now() };
}

// Demo-scoped batch export: write every still-unsent comment as one bundle,
// then flag them as exported so the next batch skips them. Replaces the old
// one-file-per-comment download, which buried reviewers (and receivers) under
// a file per click. The bundle takes the comments saved on this device by the
// other pages of the demo too (#197), so a page left unexported loses nothing.
function downloadUnsentFeedback() {
  // What another tab saved and this one has not heard of yet goes in too (#139).
  syncFeedbackFromOtherTab();
  const pages = loadOtherPagesFeedback();
  const unsent = [...state.feedback, ...pages.flatMap((page) => page.feedback)].filter((item) => !item.exported);
  downloadFeedbackItems(unsent, pages);
}

function downloadAllFeedback() {
  syncFeedbackFromOtherTab();
  const pages = loadOtherPagesFeedback();
  downloadFeedbackItems([...state.feedback, ...pages.flatMap((page) => page.feedback)], pages);
}

// pages: the other pages' saved data the items were read from, written back
// with their exported marks (#197).
function downloadFeedbackItems(listed, pages = []) {
  if (listed.length === 0) return;

  // An import refuses the whole file for one comment the receiver would refuse
  // (#196): those stay here, unexported, until they are shortened.
  const items = listed.filter((item) => !exceedsFieldLimit(item));
  const left = listed.length - items.length;
  const leftText = `コメントか投稿者名が ${formatCount(state.options.maxFieldLength)} 文字を超えている`;
  if (items.length === 0) {
    showWidgetNotice(`${leftText}ため、書き出せません。編集で短くしてください。`, true);
    return;
  }
  items.forEach((item) => applyPageUrlRule(item, state.options.keepQueryParams));
  const exportedAt = new Date().toISOString();
  try {
    const bundle = buildFeedbackBundle(items.map(toWireFeedback), exportedAt);
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
    saveFeedbackList();
    const exported = new Set(items);
    pages.filter((page) => page.feedback.some((item) => exported.has(item))).forEach(saveOtherPageFeedback);
    state.otherPages = null;
    renderFeedbackList();
    const started = "ファイルの保存を開始しました。保存できなかった場合は「全件を再ダウンロード」を使ってください。";
    showWidgetNotice(left > 0 ? `${started}${left} 件は、${leftText}ため書き出していません。編集で短くしてから書き出してください。` : started, left > 0);
    console.info("[PatchLoop] batch download", items.length, link.download);
  } catch (error) {
    showWidgetNotice("ファイルを書き出せませんでした。もう一度お試しください。", true);
    console.warn("[PatchLoop] batch download failed", error);
  }
}

function buildFeedbackBundle(feedbackList, exportedAt) {
  return {
    kind: EXPORT_BUNDLE_KIND,
    version: EXPORT_BUNDLE_VERSION,
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
  const note = root.querySelector("[data-pl-other-pages]");
  if (state.options.deliveryMode !== "download") {
    button.hidden = true;
    if (again) again.hidden = true;
    if (note) note.hidden = true;
    return;
  }
  const other = otherPagesSummary();
  if (again) again.hidden = state.feedback.length + other.total === 0;
  const unsent = state.feedback.filter((item) => !item.exported).length + other.unexported;
  button.hidden = false;
  button.disabled = unsent === 0;
  button.textContent = unsent > 0 ? `未送信を書き出す（${unsent}）` : "すべて書き出し済み";
  if (note) {
    note.hidden = other.unexported === 0;
    note.textContent = other.unexported > 0 ? `ほかのページに未書き出しのコメントが ${other.unexported} 件あります。書き出すときに一緒に入ります。` : "";
  }
}

// Counts of the other pages' saved comments (#197), read again only after
// they may have changed: an init, an export, or a write from another tab.
function otherPagesSummary() {
  if (!state.otherPages) {
    const feedback = loadOtherPagesFeedback().flatMap((page) => page.feedback);
    state.otherPages = { total: feedback.length, unexported: feedback.filter((item) => !item.exported).length };
  }
  return state.otherPages;
}

function handleStorageChange(event) {
  if (!isDemoFeedbackKey(event.key)) return;
  if (isOwnFeedbackKey(event.key)) syncFeedbackFromOtherTab();
  state.otherPages = null;
  // An export in another tab writes one key per page: count once after them.
  window.clearTimeout(state.otherPagesTimer);
  state.otherPagesTimer = window.setTimeout(updateDownloadAllButton, 100);
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
    return logDelivery(payload, { ok: null, status: "unknown", target: "slack-webhook" });
  } catch (error) {
    return logDelivery(payload, { ok: false, target: "slack-webhook", error: error.message });
  }
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

  state.feedback.slice().reverse().forEach(addCommittedMarker);
  renumberMarkers();
}

// Numbered by renumberMarkers.
function addCommittedMarker(item) {
  const marker = markerFromFeedback(item);
  if (!marker) return;
  marker.node.dataset.patchloopFeedbackId = item.id;
  state.feedbackMarkers.set(item.id, marker);
  bindMarkerHover(marker, item.id);
  bindMarkerActivation(marker, item.id);
  setMarkerApproximate(marker, state.approximateIds.get(item.id) || null);
  // Placed where its element is; out of sight in a box, it is hidden (#213).
  scheduleMarkerFollow();
}

// --- Other tabs of the page (#139) ---------------------------------------
// Every save merges what another tab saved meanwhile, and a save by another
// tab is taken in as it happens, so no tab overwrites another tab's comments.

function saveFeedbackList() {
  applyStorageChanges(persistFeedbackList());
  // The merge may have taken in another tab's edit of a comment.
  renumberMarkers();
  refreshTooltip();
}

// Returns whether a delivery left pending was taken as cut off. Draws only
// when something changed, so the list keeps its elements (and focus) otherwise.
function syncFeedbackFromOtherTab() {
  const changes = syncPersistedFeedback();
  applyStorageChanges(changes);
  // A delivery the other tab started, or one it has finished.
  const settled = settlePendingDeliveries();
  if (changes.changed || settled) {
    // Comments edited there change the marker labels and the tooltip too.
    renumberMarkers();
    refreshTooltip();
    renderFeedbackList();
  }
  return settled;
}

function applyStorageChanges({ added, removed }) {
  removed.forEach((id) => {
    state.feedbackMarkers.get(id)?.node?.remove();
    state.feedbackMarkers.delete(id);
    state.approximateIds.delete(id);
  });
  added.slice().reverse().forEach(addCommittedMarker);
  if (added.length || removed.length) renumberMarkers();
  if (state.editingId && removed.includes(state.editingId)) {
    // Replaced by a revision there (#121), maybe more than once since this tab
    // last heard: the edit goes on with the latest revision.
    const revision = state.feedback.find((item) => item.replaces === state.editingId || (Array.isArray(item.previousIds) && item.previousIds.includes(state.editingId)));
    if (revision) {
      state.editingId = revision.id;
      showWidgetNotice("このコメントは別のタブで修正版になりました。保存すると、その修正版を直します。");
    } else {
      state.editingId = null;
      closeCommentForm();
      showWidgetNotice("このコメントは別のタブで削除されました。", true);
    }
  }
}

function markerFromFeedback(item) {
  const stored = item?.target || {};
  const target = reanchoredTarget(stored);
  noteApproximate(item, Boolean(target));

  const placement = storedPlacement(target || stored);
  if (!placement) return null;
  return placement.kind === "area" ? addArea(placement) : addPin(placement);
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
// The climb stops below a box that cuts off its content (#213): what is in a
// scrolling box or a panned canvas moves while the box stays, so an area
// anchored to the box would be left behind.
function buildAreaAnchor(startElement, rect, end) {
  const elementAt = (x, y) => document.elementFromPoint(
    Math.min(Math.max(x, 0), window.innerWidth - 1),
    Math.min(Math.max(y, 0), window.innerHeight - 1)
  );
  const right = rect.leftPx + rect.widthPx - 1;
  const bottom = rect.topPx + rect.heightPx - 1;
  // A drag between items may centre on the box around them; an item it starts
  // or ends on, or one at a corner, moves with the content where the box does
  // not (#213).
  const candidates = [
    elementAt(rect.leftPx + rect.widthPx / 2, rect.topPx + rect.heightPx / 2),
    startElement,
    end && elementAt(end.clientX, end.clientY),
    elementAt(rect.leftPx, rect.topPx),
    elementAt(right, rect.topPx),
    elementAt(rect.leftPx, bottom),
    elementAt(right, bottom)
  ].map(anchorableElement).filter(Boolean);
  let anchorElement = candidates.find((element) => !cutsOffContent(element)) || candidates[0] || null;

  let cursor = anchorElement;
  for (let depth = 0; cursor && depth < 6; depth++) {
    if (rectContainsArea(cursor.getBoundingClientRect(), rect)) {
      anchorElement = cursor;
      break;
    }
    const parent = anchorableElement(cursor.parentElement);
    if (!parent || cutsOffContent(parent)) break;
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

// Stores the target's coordinates for where the geometry now puts it, as a
// capture does (storedPointAt and storedAreaFields in geometry.js).
function refreshTargetCoordinates(target, geometry) {
  const metrics = viewportMetrics();
  if (geometry.kind === "area" && target.area) {
    const { point, area } = storedAreaFields(geometry, metrics);
    Object.assign(target, point);
    Object.assign(target.area, area);
    return;
  }
  Object.assign(target, storedPointAt(geometry.pageX, geometry.pageY, metrics));
}

// #155: a comment's target stays the record of when it was confirmed, so a
// re-anchor works on a copy and only moves the marker; null when the element
// cannot be resolved.
function reanchoredTarget(target) {
  const geometry = reanchorGeometry(target);
  if (!geometry) return null;
  const copy = { ...target, area: target.area && { ...target.area } };
  refreshTargetCoordinates(copy, geometry);
  return copy;
}

// The page pixels a target's stored coordinates place it at, shaped like a
// re-anchor geometry; null when they are missing.
function storedPlacement(target) {
  if (target.kind === "area" && target.area) {
    const rect = rectFromStoredArea(target.area, viewportMetrics());
    return rect && { kind: "area", ...rect };
  }
  const point = pointFromStoredTarget(target, viewportMetrics());
  return point && { kind: "point", ...point };
}

// Returns whether the marker moved. origin: markerOrigin(), measured once by a
// caller that places many markers.
function repositionMarker(marker, target, origin = markerOrigin()) {
  if (!marker || !marker.node) return false;
  const placement = storedPlacement(target);
  if (!placement) return false;
  const style = marker.node.style;
  const before = `${style.left} ${style.top} ${style.width} ${style.height}`;
  if (placement.kind === "area") {
    Object.assign(style, {
      ...markerPosition(placement.pageLeftPx, placement.pageTopPx, origin),
      width: `${placement.widthPx}px`,
      height: `${placement.heightPx}px`
    });
  } else {
    Object.assign(style, markerPosition(placement.pageX, placement.pageY, origin));
  }
  return `${style.left} ${style.top} ${style.width} ${style.height}` !== before;
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

function markerOrigin() {
  const probe = document.createElement("div");
  probe.style.cssText = ORIGIN_PROBE_STYLE;
  document.body.append(probe);
  const origin = probe.getBoundingClientRect();
  probe.remove();
  return origin;
}

function markerPosition(pageX, pageY, origin = markerOrigin(), scroll = { x: window.scrollX, y: window.scrollY }) {
  return { left: `${pageX - scroll.x - origin.left}px`, top: `${pageY - scroll.y - origin.top}px` };
}

// Why a marker is only near its place (#200), shown on the marker and with
// the ≈ in the list.
const APPROXIMATE_TEXTS = {
  missing: "対象の要素が見つからないため、保存した位置に表示しています",
  viewport: "ウィンドウサイズが変わったため、位置が近似になっています"
};

// Notes why a comment's marker is not on its element, or that it is (#200):
// a comment made on an element whose element cannot be found now (gone,
// hidden or of no size) is "missing"; a comment made on no element (one
// larger than the viewport) keeps its stored place, which only drifts when
// the window size differs from when it was made.
function noteApproximate(item, placedOnElement) {
  let reason = null;
  if (!placedOnElement) {
    if (item?.target?.anchor) reason = "missing";
    else if (viewportDiffersFromCreation(item, viewportMetrics())) reason = "viewport";
  }
  if (reason) state.approximateIds.set(item.id, reason);
  else state.approximateIds.delete(item.id);
  return reason;
}

function setMarkerApproximate(marker, reason) {
  if (!marker || !marker.node) return;
  marker.node.classList.toggle("pl-marker-approx", Boolean(reason));
  if (reason) {
    marker.node.title = APPROXIMATE_TEXTS[reason];
  } else {
    marker.node.removeAttribute("title");
  }
}

// #213: markers sit on the document, so a box that scrolls inside the page, or
// content moved by a transform (a canvas panned with the wheel), leaves them
// behind. After a scroll, a wheel, a drag or a key, markers are put back on
// their elements every frame for as long as they move, and a marker whose
// element has left the boxes it is seen through is hidden. Only the markers
// move: the stored targets stay the record of when they were confirmed (#155).
const FOLLOW_SETTLE_MS = 300;
const FOLLOW_MOVING_MS = 150;
const FOLLOW_MAX_MS = 2000;

function followClock() {
  return typeof window.performance?.now === "function" ? window.performance.now() : Date.now();
}

function followDrag(event) {
  // Any button: a canvas may pan with the middle or the right one too.
  if (event.buttons) scheduleMarkerFollow();
}

function scheduleMarkerFollow() {
  if (state.feedbackMarkers.size === 0 && !state.pendingTarget?.markerNode) return;
  const now = followClock();
  // A new following looks the elements and the boxes they are seen through up
  // again (see markerAnchorElement and visibleBox).
  if (state.follow.frame == null) state.follow.session += 1;
  state.follow.until = Math.max(state.follow.until, now + FOLLOW_SETTLE_MS);
  state.follow.limit = now + FOLLOW_MAX_MS;
  if (state.follow.frame == null) state.follow.frame = requestFollowFrame();
}

function requestFollowFrame() {
  return typeof window.requestAnimationFrame === "function"
    ? { raf: window.requestAnimationFrame(followMarkersFrame) }
    : { timeout: window.setTimeout(followMarkersFrame, 16) };
}

function cancelMarkerFollow() {
  const frame = state.follow.frame;
  if (frame?.raf != null) window.cancelAnimationFrame?.(frame.raf);
  if (frame?.timeout != null) window.clearTimeout(frame.timeout);
  state.follow.frame = null;
  state.follow.until = 0;
}

function followMarkersFrame() {
  state.follow.frame = null;
  if (!getRoot()) return;
  const moved = followMarkers();
  const now = followClock();
  if (moved) state.follow.until = Math.min(state.follow.limit, Math.max(state.follow.until, now + FOLLOW_MOVING_MS));
  if (now < state.follow.until) state.follow.frame = requestFollowFrame();
}

// Puts every marker on its element where the element can be found (else it
// stays where it is), and hides the ones out of sight. Every measurement is
// taken before the first marker is moved, so a frame lays the page out once
// however many markers there are. Returns whether any moved.
function followMarkers() {
  const origin = markerOrigin();
  const scroll = { x: window.scrollX, y: window.scrollY };
  const boxRects = new Map();
  const plans = [];
  // Markers whose missing element has turned up (#200).
  const found = [];
  state.feedback.forEach((item) => {
    const marker = state.feedbackMarkers.get(item.id);
    if (!marker?.node) return;
    const element = markerAnchorElement(marker, item.target);
    const geometry = element && geometryOn(item.target, element);
    let placement = null;
    if (geometry) {
      const target = { ...item.target, area: item.target.area && { ...item.target.area } };
      refreshTargetCoordinates(target, geometry);
      placement = storedPlacement(target);
      if (state.approximateIds.get(item.id) === "missing") found.push({ marker, id: item.id });
    }
    plans.push({ marker, feedbackId: item.id, placement, box: element ? visibleBox(marker, element, boxRects) : null });
  });
  const pending = state.pendingTarget;
  if (pending?.markerNode) {
    if (pending.followMarker?.node !== pending.markerNode) pending.followMarker = { node: pending.markerNode };
    // The element may have been replaced by one with the same selector.
    if (!pending.anchorElement?.isConnected) {
      const replaced = elementForSelector(pending.anchor?.selector || pending.selector);
      if (replaced) pending.anchorElement = replaced;
    }
    const element = pending.anchorElement?.isConnected ? pending.anchorElement : null;
    const geometry = element && geometryOn(pending, element);
    if (geometry) refreshTargetCoordinates(pending, geometry);
    plans.push({
      marker: pending.followMarker, feedbackId: null,
      placement: geometry ? storedPlacement(pending) : null,
      box: element ? visibleBox(pending.followMarker, element, boxRects) : null
    });
  }
  let moved = false;
  plans.forEach((plan) => {
    moved = placeFollowedMarker(plan, origin, scroll) || moved;
  });
  if (found.length) {
    found.forEach(({ marker, id }) => {
      state.approximateIds.delete(id);
      setMarkerApproximate(marker, null);
    });
    renderFeedbackList();
  }
  return moved;
}

// Where a target's anchor puts it on the given element, without looking any
// other element up: a marker is placed and cut off by the same element.
function geometryOn(target, element) {
  const anchor = target && target.anchor;
  if (!anchor || numberOrNull(anchor.x) == null || numberOrNull(anchor.y) == null) return null;
  const rect = elementRectOrNull(element);
  return rect ? geometryFromAnchor(target.kind, anchor, rect, window.scrollX, window.scrollY) : null;
}

// The element a marker is placed on, looked up again once per following (an
// element may have been replaced) and kept for its frames.
function markerAnchorElement(marker, target) {
  if (marker.anchorSession !== state.follow.session || !marker.anchorElement?.isConnected) {
    marker.anchorElement = elementForSelector(target?.anchor?.selector || target?.selector);
    marker.anchorSession = state.follow.session;
  }
  return marker.anchorElement;
}

// The part of the viewport where the element can be seen: the overlap of its
// ancestors that cut off what overflows them (overflow other than visible),
// each on the axes it cuts off (overflow-x: clip with overflow-y: visible cuts
// off sideways only); null when none does. The ancestors are found again once
// per following; their boxes are measured once per frame however many
// markers share them. Not followed: a fixed or absolutely placed element that
// escapes an ancestor's overflow.
function visibleBox(marker, element, boxRects) {
  if (marker.clipSession !== state.follow.session || marker.clipFor !== element) {
    marker.clipAncestors = clippingAncestors(element);
    marker.clipFor = element;
    marker.clipSession = state.follow.session;
  }
  if (marker.clipAncestors.length === 0) return null;
  const box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  for (const { node, x, y } of marker.clipAncestors) {
    if (!boxRects.has(node)) boxRects.set(node, node.getBoundingClientRect());
    const rect = boxRects.get(node);
    if (x) {
      box.left = Math.max(box.left, rect.left);
      box.right = Math.min(box.right, rect.right);
    }
    if (y) {
      box.top = Math.max(box.top, rect.top);
      box.bottom = Math.min(box.bottom, rect.bottom);
    }
  }
  return box;
}

function clippingAncestors(element) {
  const ancestors = [];
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const axes = cutOffAxes(node);
    if (axes.x || axes.y) ancestors.push({ node, ...axes });
  }
  return ancestors;
}

// The axes on which a box cuts off its content (overflow other than visible).
function cutOffAxes(node) {
  if (typeof window.getComputedStyle !== "function") return { x: false, y: false };
  const style = window.getComputedStyle(node);
  return { x: Boolean(style) && style.overflowX !== "visible", y: Boolean(style) && style.overflowY !== "visible" };
}

// A box whose overflow is other than visible on some axis: it cuts off its
// content, which may scroll or be moved inside it.
function cutsOffContent(node) {
  const axes = cutOffAxes(node);
  return axes.x || axes.y;
}

// Writes what followMarkers worked out. A pin whose point is out of its box is
// hidden; an area is cut down to the part in its box, or hidden when none is.
// Hidden markers take no room (display: none), so a marker carried far off
// does not stretch the page. Returns whether the marker moved.
// Writes only: the scroll and the origin come measured. An area cut down to
// its box also cuts off its number where it no longer fits.
function placeFollowedMarker({ marker, feedbackId, placement, box }, origin, scroll) {
  const node = marker.node;
  const style = node.style;
  const before = `${style.left} ${style.top} ${style.width} ${style.height}`;
  let hidden = false;
  let cut = false;
  if (placement?.kind === "area") {
    const full = { left: placement.pageLeftPx - scroll.x, top: placement.pageTopPx - scroll.y };
    full.right = full.left + placement.widthPx;
    full.bottom = full.top + placement.heightPx;
    let { left, top, right, bottom } = full;
    if (box) {
      left = Math.max(left, box.left);
      top = Math.max(top, box.top);
      right = Math.min(right, box.right);
      bottom = Math.min(bottom, box.bottom);
      hidden = right <= left || bottom <= top;
      cut = !hidden && (left > full.left || top > full.top || right < full.right || bottom < full.bottom);
    }
    if (!hidden) {
      Object.assign(style, {
        ...markerPosition(left + scroll.x, top + scroll.y, origin, scroll),
        width: `${right - left}px`,
        height: `${bottom - top}px`
      });
    }
  } else if (placement) {
    const x = placement.pageX - scroll.x;
    const y = placement.pageY - scroll.y;
    hidden = Boolean(box) && (x < box.left || x > box.right || y < box.top || y > box.bottom);
    if (!hidden) Object.assign(style, markerPosition(placement.pageX, placement.pageY, origin, scroll));
  }
  node.classList.toggle("pl-marker-clipped", hidden);
  node.classList.toggle("pl-marker-cut", cut);
  if (hidden && feedbackId && getTooltip()?.dataset.feedbackId === feedbackId) hideTooltip();
  return `${style.left} ${style.top} ${style.width} ${style.height}` !== before;
}

// Pages that draw their content after the widget starts (#200): while a
// marker's element cannot be found, re-anchoring is tried again a few times
// over the first seconds, and the marker keeps its ≈ only if it stays missing.
const MISSING_RETRY_DELAYS_MS = [500, 1000, 1500];

function scheduleMissingRetry(attempt = 0) {
  window.clearTimeout(state.missingRetryTimer);
  state.missingRetryTimer = null;
  if (attempt >= MISSING_RETRY_DELAYS_MS.length || missingFeedback().length === 0) return;
  state.missingRetryTimer = window.setTimeout(() => {
    state.missingRetryTimer = null;
    retryMissingMarkers();
    scheduleMissingRetry(attempt + 1);
  }, MISSING_RETRY_DELAYS_MS[attempt]);
}

// The comments listed now whose element could not be found.
function missingFeedback() {
  return state.feedback.filter((item) => state.approximateIds.get(item.id) === "missing");
}

// Re-anchors only the markers whose element is missing, as they are when the
// try comes; the others stay where they are.
function retryMissingMarkers() {
  let found = false;
  missingFeedback().forEach((item) => {
    const target = reanchoredTarget(item.target);
    if (!target) return;
    const marker = state.feedbackMarkers.get(item.id);
    repositionMarker(marker, target);
    setMarkerApproximate(marker, noteApproximate(item, true));
    found = true;
  });
  if (!found) return;
  renderFeedbackList();
  // A marker put back on its element may be out of sight in a box (#213).
  scheduleMarkerFollow();
}

function handleWindowResize() {
  positionVisibleCommentForm();
  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(reanchorAllMarkers, 200);
}

function reanchorAllMarkers() {
  state.feedback.forEach((item) => {
    const marker = state.feedbackMarkers.get(item.id);
    const target = reanchoredTarget(item.target);
    // An earlier re-anchor may have moved it; else back to the stored position.
    repositionMarker(marker, target || item.target);
    setMarkerApproximate(marker, noteApproximate(item, Boolean(target)));
  });

  if (state.pendingTarget) {
    const pending = state.pendingTarget;
    const geometry = reanchorGeometry(pending, pending.anchorElement);
    if (geometry) {
      refreshTargetCoordinates(pending, geometry);
      repositionMarker({ node: pending.markerNode }, pending);
    }
  }

  renderFeedbackList();
  // A resize may change what cuts the markers off: look it up again.
  state.follow.session += 1;
  scheduleMarkerFollow();
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
  // Closed while tucked (#211): the button that had focus is gone with the panel.
  else if (state.launcher === "tab") focusLauncher();
}

// Tucks the collapsed button into a small tab at the screen's edge, or brings
// it back (#211), and keeps the choice on this device.
function setLauncher(launcher) {
  launcherChosen = launcher;
  state.launcher = launcher;
  saveLauncher(launcher);
  applyCollapseState();
  focusLauncher();
}

// What stands for the widget while the panel is closed: the tab when tucked,
// else the panel's button.
function focusLauncher() {
  const root = getRoot();
  const tucked = state.collapsed && state.launcher === "tab";
  root?.querySelector(tucked ? "[data-pl-tab]" : "[data-pl-collapse]")?.focus({ preventScroll: true });
}

function applyCollapseState() {
  const root = getRoot();
  if (!root) return;
  const panel = root.querySelector("[data-pl-panel]");
  if (panel) panel.classList.toggle("pl-collapsed", state.collapsed);
  // Tucked (#211): only the tab shows while the panel is closed.
  const tucked = state.collapsed && state.launcher === "tab";
  if (panel) panel.hidden = tucked;
  const tab = root.querySelector("[data-pl-tab]");
  if (tab) tab.hidden = !tucked;
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
  if (clear) clear.disabled = state.feedback.some(isDelivering);
  // A comment focused from its marker, or one of its buttons, stays focused
  // across the re-render below, which replaces every list item (a delivery
  // reply, re-anchoring, another tab's save).
  const focused = document.activeElement;
  const focusedItem = list.contains(focused) ? focused.closest("[data-feedback-id]") : null;
  const focusedId = focusedItem ? focusedItem.dataset.feedbackId : null;
  const focusedButton = focusedItem && focused !== focusedItem ? LIST_BUTTONS.find((selector) => focused.matches(selector)) : null;
  if (state.feedback.length === 0) {
    list.innerHTML = '<p class="pl-feedback-list-empty">まだコメントはありません。<br />「コメントを追加」から最初の気づきを残しましょう。</p>';
    return;
  }
  list.innerHTML = state.feedback
    .map((item, i) => {
      const num = state.feedback.length - i;
      const kind = (item.target && item.target.kind) || "point";
      const badge = deliveryBadge(item);
      const title = badge?.explained ? ` title="${escapeHtml(deliveryStatusText(item.delivery, state.options.maxFieldLength))}"` : "";
      const delivery = badge ? `<span class="pl-feedback-status pl-feedback-status-${badge.tone}"${title}>${badge.label}</span>` : "";
      const approximate = state.approximateIds.has(item.id)
        ? `<span class="pl-feedback-approx" title="${APPROXIMATE_TEXTS[state.approximateIds.get(item.id)]}">≈</span>`
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
            ${canRetry(item) ? '<button type="button" data-pl-retry>再送</button>' : ""}
            <button type="button" data-pl-edit title="この端末のコメントを編集"${isDelivering(item) ? " disabled" : ""}>編集</button>
            <button type="button" data-pl-delete title="この端末のコメントを削除"${isDelivering(item) ? " disabled" : ""}>削除</button>
          </div>
        </article>
      `;
    })
    .join("");
  if (focusedId) {
    const item = feedbackListItem(focusedId);
    const button = focusedButton ? item?.querySelector(focusedButton) : null;
    (button && !button.disabled ? button : item)?.focus({ preventScroll: true });
  }
}

const LIST_BUTTONS = ["[data-pl-retry]", "[data-pl-edit]", "[data-pl-delete]"];

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
// runs on load, when the user opens the panel (its button or a marker) and when
// the tab comes back, no more often than the lookup state allows (longer after
// failures), and stops for the page once the receiver has no lookup for it.
// Only the receiver delivery mode asks.
async function refreshInboxStatuses() {
  if (state.statusLookupRequest || state.statusLookup.stopped || Date.now() < state.statusLookup.nextAt) return;
  if (state.options.deliveryMode !== "receiver") return;
  const url = statusLookupUrl(state.options.endpoint, document.baseURI);
  const ids = statusLookupIds(state.feedback);
  if (!url || ids.length === 0) return;
  // Re-init, destroy and a change of the delivery settings drop the request in
  // flight; its answer is then left unused.
  const request = {};
  state.statusLookupRequest = request;
  let answer = { httpStatus: 0, statuses: null };
  try {
    const headers = { "Content-Type": "application/json" };
    if (state.options.ingestKey) headers["X-PatchLoop-Ingest-Key"] = state.options.ingestKey;
    answer = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: state.options.projectId, ids })
    }, async (response) => ({
      httpStatus: response.status,
      statuses: response.ok ? statusesFromAnswer(await response.json()) : null
    }));
  } catch (error) {
    console.info("[PatchLoop] inbox status lookup failed", error);
  }
  if (state.statusLookupRequest !== request) return;
  state.statusLookupRequest = null;
  const outcome = lookupOutcome(answer.httpStatus, answer.statuses);
  state.statusLookup = lookupAfter(state.statusLookup, outcome, Date.now());
  state.inboxStatus = outcome === "ok" ? { statuses: answer.statuses, asked: new Set(ids) } : null;
  renderFeedbackList();
}

function resetInboxStatus() {
  state.inboxStatus = null;
  state.statusLookup = initialLookupState();
  state.statusLookupRequest = null;
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") refreshInboxStatuses();
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
  // Another tab may have retried it, or deleted or edited it, without this
  // tab having heard of it yet (#139).
  syncFeedbackFromOtherTab();
  const item = state.feedback.find((entry) => entry.id === id);
  if (!item || !canRetry(item)) return;
  if (!shouldDeliverFeedback()) {
    showWidgetNotice("送信先・設定を確認してください。ファイル共有の場合は書き出しを使います。", true);
    return;
  }
  // Before its state is touched (#196): a delivery that was cut off keeps
  // saying the receiver may hold it, so a later edit still goes as a revision
  // (#121). deliverFeedback checks again as it leaves.
  if (exceedsFieldLimit(item)) {
    showWidgetNotice(tooLongToSendText(state.options.maxFieldLength), true);
    return;
  }
  item.delivery = pendingDelivery();
  state.deliveringIds.add(item.id);
  saveFeedbackList();
  renderFeedbackList();
  if (!(await deliverFeedback(item)) || getRoot() !== root) return;
  saveFeedbackList();
  renderFeedbackList();
  showWidgetNotice(deliveryStatusText(item.delivery, state.options.maxFieldLength), deliveryFailed(item.delivery));
  focusLauncher();
}

function startEditFeedback(id) {
  // What another tab did to it decides how the edit goes (#121).
  syncFeedbackFromOtherTab();
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
  saveFeedbackList();
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
    refreshInboxStatuses();
  });
}

function showTooltip(event, item) {
  const tooltip = getTooltip();
  if (!tooltip) return;
  tooltip.dataset.feedbackId = item.id;
  tooltip.textContent = tooltipText(item);
  tooltip.hidden = false;
  positionTooltip(event);
}

function tooltipText(item) {
  return `${item.reviewer || "(no name)"}\n${item.comment || ""}`;
}

// After another tab's change (#139): the shown comment's current text, or no
// tooltip once the comment is gone.
function refreshTooltip() {
  const tooltip = getTooltip();
  if (!tooltip || tooltip.hidden) return;
  const item = state.feedback.find((entry) => entry.id === tooltip.dataset.feedbackId);
  if (item) tooltip.textContent = tooltipText(item);
  else hideTooltip();
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
  style.textContent = WIDGET_CSS;
  document.head.append(style);
}

const api = {
  init,
  destroy,
  setFeedbackMode,
  getFeedback: () => [...state.feedback]
};

window.PatchLoop = api;
