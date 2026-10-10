"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.
const DISPLAY_MODE_KEY = "patchloop:display-mode";

function displaySwitch(widget) {
  return widget.document.querySelector("[data-pl-display-mode]");
}

function chooseDisplayMode(widget, mode) {
  const radio = displaySwitch(widget).querySelector(`input[value="${mode}"]`);
  radio.checked = true;
  displaySwitch(widget).emit("change", { target: radio });
}

function checkedMode(widget) {
  return displaySwitch(widget).querySelectorAll("input").filter((input) => input.checked).map((input) => input.value);
}

function markerDots(widget) {
  return [
    ...widget.document.querySelectorAll("[data-patchloop-pin]"),
    ...widget.document.querySelectorAll("[data-patchloop-area]")
  ].map((node) => node.classList.contains("pl-marker-dot"));
}

test("the display switch is a fieldset of three radios that starts on 通常 with full markers", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  await widget.submit("Area comment", { area: true });
  const fieldset = displaySwitch(widget);
  assert.equal(fieldset.tagName, "FIELDSET");
  assert.equal(fieldset.querySelector("legend").textContent, "マーカーの表示");
  assert.deepEqual(fieldset.querySelectorAll("label").map((label) => label.textContent.trim()), ["通常", "ドットだけ", "全部"]);
  assert.deepEqual(fieldset.querySelectorAll("input").map((input) => [input.type, input.getAttribute("name"), input.value]), [
    ["radio", "patchloop-display-mode", "normal"],
    ["radio", "patchloop-display-mode", "dots"],
    ["radio", "patchloop-display-mode", "all"]
  ]);
  assert.deepEqual(checkedMode(widget), ["normal"]);
  assert.deepEqual(markerDots(widget), [false, false]);
});

test("ドットだけ turns committed point and area markers into dots, and 通常 / 全部 bring them back", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  await widget.submit("Area comment", { area: true });
  chooseDisplayMode(widget, "dots");
  assert.deepEqual(markerDots(widget), [true, true]);
  assert.equal(widget.window.localStorage.getItem(DISPLAY_MODE_KEY), "dots");
  chooseDisplayMode(widget, "all");
  assert.deepEqual(markerDots(widget), [false, false]);
  assert.equal(widget.window.localStorage.getItem(DISPLAY_MODE_KEY), "all");
  chooseDisplayMode(widget, "dots");
  chooseDisplayMode(widget, "normal");
  assert.deepEqual(markerDots(widget), [false, false]);
  assert.equal(widget.window.localStorage.getItem(DISPLAY_MODE_KEY), "normal");
});

test("in ドットだけ the marker of a comment being written stays full until the comment is sent", async () => {
  const widget = widgetHarness();
  widget.init();
  chooseDisplayMode(widget, "dots");
  widget.capture();
  assert.deepEqual(markerDots(widget), [false]);
  await widget.submit("Dot comment", { captureTarget: false });
  assert.deepEqual(markerDots(widget), [true]);
});

test("the chosen mode is remembered and applied to restored markers on the next init", async () => {
  const widget = widgetHarness();
  widget.init({ persistFeedback: true });
  await widget.submit("Remembered comment");
  chooseDisplayMode(widget, "dots");
  widget.init({ persistFeedback: true });
  assert.deepEqual(checkedMode(widget), ["dots"]);
  assert.deepEqual(markerDots(widget), [true]);
});

test("an unknown stored mode starts on 通常", () => {
  const widget = widgetHarness();
  widget.window.localStorage.setItem(DISPLAY_MODE_KEY, "hidden");
  widget.init();
  assert.deepEqual(checkedMode(widget), ["normal"]);
});

test("without usable storage the switch starts on 通常 and still changes the markers", async () => {
  const widget = widgetHarness();
  widget.window.localStorage.getItem = () => { throw new Error("storage blocked"); };
  widget.window.localStorage.setItem = () => { throw new Error("storage blocked"); };
  widget.init();
  assert.deepEqual(checkedMode(widget), ["normal"]);
  await widget.submit("Unsaved mode");
  chooseDisplayMode(widget, "dots");
  assert.deepEqual(markerDots(widget), [true]);
});

test("activating a marker opens the panel and focuses its comment in the list", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  await widget.submit("Area comment", { area: true });
  widget.api.setFeedbackMode(false);
  const [areaId, pointId] = widget.api.getFeedback().map((item) => item.id);
  const panel = widget.document.querySelector("[data-pl-panel]");
  const toggle = widget.document.querySelector("[data-pl-collapse]");
  toggle.click();
  assert.equal(panel.classList.contains("pl-collapsed"), true);

  widget.document.querySelector("[data-patchloop-pin]").click();
  assert.equal(panel.classList.contains("pl-collapsed"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(widget.document.activeElement.dataset.feedbackId, pointId);
  assert.equal(widget.document.activeElement.getAttribute("tabindex"), "-1");

  widget.document.querySelector("[data-patchloop-area]").querySelector("button").click();
  assert.equal(widget.document.activeElement.dataset.feedbackId, areaId);
});

test("a marker restored from storage also opens its comment", async () => {
  const widget = widgetHarness();
  widget.init({ persistFeedback: true });
  await widget.submit("Restored comment");
  widget.api.setFeedbackMode(false);
  const [id] = widget.api.getFeedback().map((item) => item.id);
  widget.init({ persistFeedback: true });
  widget.document.querySelector("[data-patchloop-pin]").click();
  assert.equal(widget.document.activeElement.dataset.feedbackId, id);
});

test("while a spot is being chosen, activating a marker leaves the panel and focus alone", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  widget.api.setFeedbackMode(false);
  widget.api.setFeedbackMode(true);
  const panel = widget.document.querySelector("[data-pl-panel]");
  assert.equal(panel.classList.contains("pl-collapsed"), true);
  widget.document.querySelector("[data-patchloop-pin]").click();
  assert.equal(panel.classList.contains("pl-collapsed"), true);
  assert.equal(widget.document.activeElement.dataset.feedbackId, undefined);
});
