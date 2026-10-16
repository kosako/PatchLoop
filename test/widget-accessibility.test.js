"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

test("point and area markers have descriptive names and focusable labels", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  await widget.submit("Area comment", { area: true });
  const point = widget.document.querySelector("[data-patchloop-pin]");
  const area = widget.document.querySelector("[data-patchloop-area]").querySelector("button");
  assert.equal(point.tagName, "BUTTON");
  assert.equal(point.getAttribute("aria-label"), "点のフィードバック 1: Point comment");
  assert.ok(area, "area marker must have a native keyboard-focusable label");
  assert.equal(area.type, "button");
  assert.equal(area.getAttribute("aria-label"), "範囲のフィードバック 2: Area comment");
});

test("marker focus displays its tooltip, which stays through mouseleave and closes with Escape or blur", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Keyboard-readable comment");
  widget.api.setFeedbackMode(false);
  const point = widget.document.querySelector("[data-patchloop-pin]");
  const tooltip = widget.document.querySelector("[data-pl-tooltip]");
  point.focus();
  assert.equal(tooltip.getAttribute("role"), "tooltip");
  assert.equal(point.getAttribute("aria-describedby"), tooltip.getAttribute("id"));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, "Reviewer\nKeyboard-readable comment");
  assert.match(tooltip.style.left, /^\d+px$/);
  assert.match(tooltip.style.top, /^\d+px$/);
  point.emit("mouseleave");
  assert.equal(tooltip.hidden, false);
  point.emit("keydown", { key: "Escape" });
  assert.equal(tooltip.hidden, true);
  assert.equal(widget.document.activeElement, point);
  widget.document.querySelector("[data-pl-collapse]").focus();
  point.focus();
  assert.equal(tooltip.hidden, false);
  widget.document.querySelector("[data-pl-collapse]").focus();
  assert.equal(tooltip.hidden, true);
});

test("Escape cancels a pending comment and restores focus to the previous control", () => {
  const widget = widgetHarness();
  widget.init();
  const trigger = widget.document.querySelector("[data-pl-collapse]");
  trigger.focus();
  widget.capture();
  const form = widget.document.querySelector("[data-pl-comment]");
  assert.equal(widget.document.activeElement, form.querySelector("[data-pl-comment-text]"));
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 1);
  form.emit("keydown", { key: "Escape" });
  assert.equal(form.hidden, true);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 0);
  assert.equal(widget.api.getFeedback().length, 0);
  assert.equal(widget.requests.length, 0);
  assert.equal(widget.document.activeElement, trigger);
});

test("Escape during IME composition does not cancel a comment", () => {
  const widget = widgetHarness();
  widget.init();
  widget.capture();
  const form = widget.document.querySelector("[data-pl-comment]");
  form.emit("keydown", { key: "Escape", isComposing: true });
  assert.equal(form.hidden, false);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 1);
});

test("canceling an edit preserves the comment and returns focus to its edit button", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Original comment");
  const edit = widget.document.querySelector("[data-pl-edit]");
  edit.focus();
  edit.click();
  const form = widget.document.querySelector("[data-pl-comment]");
  form.querySelector("[data-pl-comment-text]").value = "Canceled edit";
  form.emit("keydown", { key: "Escape" });
  assert.equal(widget.api.getFeedback()[0].comment, "Original comment");
  assert.equal(widget.document.activeElement, edit);
  assert.equal(form.hidden, true);
});

test("editing and deleting comments refresh marker names and restore focus after rerender", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("First comment");
  await widget.submit("Second comment");
  const edit = widget.document.querySelector("[data-pl-edit]");
  edit.focus();
  edit.click();
  await widget.submit("Updated comment", { captureTarget: false });
  const points = widget.document.querySelectorAll("[data-patchloop-pin]");
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 2: Updated comment");
  assert.equal(widget.document.activeElement, widget.document.querySelector("[data-pl-collapse]"));
  const oldestCard = widget.document.querySelectorAll("[data-feedback-id]")[1];
  oldestCard.querySelector("[data-pl-delete]").click();
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 1: Updated comment");
});

for (const remaining of [0, 1]) {
  test(`deleting the edited comment restores connected focus with ${remaining} comments remaining`, async () => {
    const widget = widgetHarness();
    widget.init();
    if (remaining) await widget.submit("Keep this comment");
    await widget.submit("Delete this comment");
    const list = widget.document.querySelector("[data-pl-list]");
    const card = list.querySelector("[data-feedback-id]");
    const edit = card.querySelector("[data-pl-edit]");
    edit.focus();
    edit.click();
    const form = widget.document.querySelector("[data-pl-comment]");
    assert.equal(form.hidden, false);
    const remove = card.querySelector("[data-pl-delete]");
    remove.focus();
    remove.click();
    assert.equal(form.hidden, true);
    assert.equal(widget.api.getFeedback().length, remaining);
    assert.equal(widget.api.getFeedback().some((item) => item.id === card.dataset.feedbackId), false);
    assert.equal(widget.document.activeElement, widget.document.querySelector("[data-pl-collapse]"));
    assert.equal(widget.document.activeElement.isConnected, true);
    assert.equal(widget.requests.length, remaining + 1);
  });
}

test("restored markers retain accessible names and focus tooltips", async () => {
  const widget = widgetHarness();
  widget.init({ persistFeedback: true });
  await widget.submit("Persisted comment", { area: true });
  widget.api.destroy();
  widget.init({ persistFeedback: true });
  const label = widget.document.querySelector("[data-patchloop-area]").querySelector("button");
  assert.equal(label.getAttribute("aria-label"), "範囲のフィードバック 1: Persisted comment");
  label.focus();
  assert.equal(widget.document.querySelector("[data-pl-tooltip]").hidden, false);
});

function rgb(hex) {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((char) => char + char).join("") : digits;
  assert.match(full, /^[\da-f]{6}$/i);
  return full.match(/../g).map((value) => parseInt(value, 16) / 255);
}

function luminance(color) {
  const [red, green, blue] = color.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// The widget's rules in source order, each with the @media it sits in (null
// outside any).
function styleRules(widget) {
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  const rules = [];
  const preludes = [];
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      preludes.push(css.slice(start, index).trim());
      start = index + 1;
    } else if (css[index] === "}") {
      const prelude = preludes.pop();
      if (!prelude.startsWith("@")) {
        const declarations = {};
        for (const part of css.slice(start, index).split(";")) {
          const colon = part.indexOf(":");
          if (colon === -1) continue;
          const property = part.slice(0, colon).trim();
          declarations[property === "background-color" ? "background" : property] = part.slice(colon + 1).trim();
        }
        rules.push({ selector: prelude, declarations, media: preludes.findLast((outer) => outer.startsWith("@media")) ?? null });
      }
      start = index + 1;
    }
  }
  return rules;
}

// What applies by selector outside @media: a selector's rules merged in source
// order, so a later rule's color or background wins as in the page.
function cascadedRules(rules) {
  const merged = new Map();
  for (const { selector, declarations, media } of rules) {
    if (!media) merged.set(selector, { ...merged.get(selector), ...declarations });
  }
  return merged;
}

test("every text color of the widget meets 4.5:1 on the backgrounds it is shown on (#125)", () => {
  const widget = widgetHarness();
  widget.init();
  const allRules = styleRules(widget);
  // A color or background that only some viewports get needs a check of its own.
  for (const { selector, declarations, media } of allRules) {
    if (media) assert.ok(!declarations.color && !declarations.background, `${selector} in ${media}: color or background not checked for contrast`);
  }
  const rules = cascadedRules(allRules);
  const checked = new Set();
  const check = (selector, backgroundSelector, composite = (color) => color) => {
    const background = rules.get(backgroundSelector)?.background;
    assert.ok(background, `${backgroundSelector} has a background`);
    const ratio = contrast(composite(rgb(rules.get(selector).color)), composite(rgb(background)));
    assert.ok(ratio >= 4.5, `${selector} on ${backgroundSelector}: ${ratio.toFixed(2)}`);
    checked.add(selector);
  };
  // A disabled control: WCAG leaves inactive components out of the contrast minimum.
  const exempt = new Set([".pl-actions [data-pl-download-all]:disabled"]);

  // Rules that set both: the text on its own background.
  for (const [selector, rule] of rules) {
    if (rule.color && rule.background && !exempt.has(selector)) check(selector, selector);
  }
  // The other states a control shows the same text color on.
  check(".pl-handle", ".pl-handle:hover");
  check(".pl-handle.pl-mode-on", ".pl-handle.pl-mode-on:hover");
  check(".pl-panel.pl-collapsed .pl-handle", ".pl-panel.pl-collapsed .pl-handle.pl-mode-on");
  check(".pl-mode", '.pl-mode[aria-pressed="true"]');
  check(".pl-pin", ".pl-pin.pl-marker-done, .pl-area.pl-marker-done button");
  check(".pl-area button", ".pl-pin.pl-marker-done, .pl-area.pl-marker-done button");
  check(".pl-feedback-num", ".pl-feedback-num.kind-point");
  check(".pl-feedback-num", ".pl-feedback-num.kind-area");
  check(".pl-list-heading", ".pl-list-heading span");
  // Text without a background of its own, on the box it is shown in.
  for (const selector of [".pl-root", ".pl-panel p", ".pl-delivery-settings summary", ".pl-delivery-settings label", ".pl-feedback-list-empty", ".pl-list-heading", ".pl-display-mode legend", ".pl-display-mode label", ".pl-actions [data-pl-clear]", ".pl-panel .pl-other-pages"]) {
    check(selector, ".pl-panel");
  }
  for (const selector of [".pl-root", ".pl-comment label", ".pl-form-heading span", ".pl-comment .pl-capture-note, .pl-comment .pl-edit-note", ".pl-keyboard-hint"]) {
    check(selector, ".pl-comment");
  }
  check(".pl-capture-guide small", ".pl-capture-guide");
  check(".pl-feedback-actions [data-pl-delete]", ".pl-feedback-actions button");
  // Comment cards, plain and exported (an exported card may be faded).
  const alpha = Number(rules.get(".pl-feedback-item-exported").opacity ?? 1);
  const card = rgb(rules.get(".pl-feedback-item").background);
  const faded = (color) => color.map((value, index) => value * alpha + card[index] * (1 - alpha));
  for (const selector of [".pl-feedback-text", ".pl-feedback-meta", ".pl-feedback-status-ok", ".pl-feedback-status-unknown", ".pl-feedback-status-fail", ".pl-feedback-approx", ".pl-feedback-exported", ".pl-inbox-status", ".pl-inbox-status-done", ".pl-inbox-status-missing"]) {
    check(selector, ".pl-feedback-item");
    check(selector, ".pl-feedback-item-exported", faded);
  }

  // A text color added later fails here until it is checked above.
  for (const [selector, rule] of rules) {
    if (!rule.color) continue;
    assert.match(rule.color, /^#[\da-f]{3}(?:[\da-f]{3})?$/i, `${selector}: color as a hex value`);
    assert.ok(checked.has(selector) || exempt.has(selector), `${selector}: text color not checked for contrast`);
  }
});
