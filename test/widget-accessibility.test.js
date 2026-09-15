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
  widget.document.querySelector("[data-pl-list]").emit("click", { target: edit });
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
  widget.document.querySelector("[data-pl-list]").emit("click", { target: edit });
  await widget.submit("Updated comment", { captureTarget: false });
  const points = widget.document.querySelectorAll("[data-patchloop-pin]");
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 2: Updated comment");
  assert.equal(widget.document.activeElement, widget.document.querySelector("[data-pl-collapse]"));
  const oldestCard = widget.document.querySelectorAll("[data-feedback-id]")[1];
  widget.document.querySelector("[data-pl-list]").emit("click", { target: oldestCard.querySelector("[data-pl-delete]") });
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
    list.emit("click", { target: edit });
    const form = widget.document.querySelector("[data-pl-comment]");
    assert.equal(form.hidden, false);
    const remove = card.querySelector("[data-pl-delete]");
    remove.focus();
    list.emit("click", { target: remove });
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

test("normal text and marker badges meet 4.5:1, including exported cards", () => {
  const widget = widgetHarness();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  const rules = new Map([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
    match[1].trim(), Object.fromEntries(match[2].split(";").filter((part) => part.trim()).map((part) => part.split(":").map((value) => value.trim())))
  ]));
  for (const selector of [".pl-pin", ".pl-area button", ".pl-mode", ".pl-handle.pl-mode-on"]) {
    const rule = rules.get(selector);
    assert.ok(contrast(rgb(rule.color), rgb(rule.background)) >= 4.5, selector);
  }
  assert.ok(contrast(rgb(rules.get(".pl-handle.pl-mode-on").color), rgb(rules.get(".pl-handle.pl-mode-on:hover").background)) >= 4.5, "active handle hover");
  const numberColor = rules.get(".pl-feedback-num").color;
  for (const kind of ["point", "area"]) {
    assert.ok(contrast(rgb(numberColor), rgb(rules.get(`.pl-feedback-num.kind-${kind}`).background)) >= 4.5, `${kind} number`);
  }
  const card = rules.get(".pl-feedback-item");
  const exported = rules.get(".pl-feedback-item-exported");
  const alpha = Number(exported.opacity ?? 1);
  const composite = (color) => color.map((value, index) => value * alpha + rgb(card.background)[index] * (1 - alpha));
  for (const selector of [".pl-feedback-text", ".pl-feedback-meta", ".pl-feedback-status-unknown", ".pl-feedback-status-fail", ".pl-feedback-approx", ".pl-feedback-exported", ".pl-feedback-actions [data-pl-delete]"]) {
    const color = rgb(rules.get(selector).color);
    assert.ok(contrast(color, rgb(card.background)) >= 4.5, selector);
    assert.ok(contrast(composite(color), composite(rgb(exported.background || card.background))) >= 4.5, `${selector} in exported card`);
  }
});
