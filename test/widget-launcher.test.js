"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.
const LAUNCHER_KEY = "patchloop:launcher";

function parts(widget) {
  const document = widget.document;
  return {
    panel: document.querySelector("[data-pl-panel]"),
    handle: document.querySelector("[data-pl-collapse]"),
    tuck: document.querySelector("[data-pl-tuck]"),
    tab: document.querySelector("[data-pl-tab]")
  };
}

// What shows while the panel is closed: "button" (the panel's button) or "tab".
function shown(widget) {
  const { panel, tab } = parts(widget);
  return `${panel.hidden ? "" : "panel"}${tab.hidden ? "" : "tab"}`;
}

test("the collapsed button tucks into a tab at the edge and comes back, moving focus along (#211)", () => {
  const storage = new Map();
  const widget = widgetHarness({ storage });
  widget.init();
  const { handle, tuck, tab } = parts(widget);
  assert.equal(tuck.tagName, "BUTTON");
  assert.equal(tuck.getAttribute("aria-label"), "フィードバックのボタンを右端にしまう");
  assert.equal(tab.tagName, "BUTTON");
  assert.equal(tab.getAttribute("aria-label"), "フィードバックのボタンを出す");
  assert.equal(shown(widget), "panel");

  tuck.focus();
  tuck.click();
  assert.equal(shown(widget), "tab");
  assert.ok(widget.document.activeElement === tab, "focus moves to the tab");
  assert.equal(storage.get(LAUNCHER_KEY), "tab");

  tab.click();
  assert.equal(shown(widget), "panel");
  assert.ok(widget.document.activeElement === handle, "focus moves back to the button");
  assert.equal(storage.get(LAUNCHER_KEY), "button");
});

test("a tucked button stays tucked after a reload, and without storage it stays for the page only (#211)", () => {
  const reloaded = widgetHarness({ storage: new Map([[LAUNCHER_KEY, "tab"]]) });
  reloaded.init();
  assert.equal(shown(reloaded), "tab");

  const unknown = widgetHarness({ storage: new Map([[LAUNCHER_KEY, "sideways"]]) });
  unknown.init();
  assert.equal(shown(unknown), "panel");

  const blocked = new Map();
  blocked.get = () => { throw new Error("storage blocked"); };
  blocked.set = () => { throw new Error("storage blocked"); };
  const widget = widgetHarness({ storage: blocked });
  widget.init();
  assert.equal(shown(widget), "panel");
  parts(widget).tuck.click();
  assert.equal(shown(widget), "tab");
});

test("a marker opens the panel while tucked, and closing it goes back to the tab (#211)", async () => {
  const widget = widgetHarness({ storage: new Map([[LAUNCHER_KEY, "tab"]]) });
  widget.init();
  await widget.submit("Point comment");
  widget.api.setFeedbackMode(false);
  const { handle, tab } = parts(widget);
  // A new comment opens the panel on the list, as it does untucked.
  assert.equal(shown(widget), "panel");
  handle.click();
  assert.equal(shown(widget), "tab");

  widget.document.querySelector("[data-patchloop-pin]").click();
  assert.equal(shown(widget), "panel");
  assert.equal(handle.getAttribute("aria-expanded"), "true");

  handle.focus();
  handle.click();
  assert.equal(shown(widget), "tab");
  assert.ok(widget.document.activeElement === tab, "focus moves to the tab when the panel closes");
});

test("while choosing a place, the tab and the tuck button take the mode's color, and Escape returns focus to the tab (#211)", () => {
  const plain = widgetHarness();
  plain.init();
  plain.api.setFeedbackMode(true);
  assert.equal(parts(plain).tuck.classList.contains("pl-mode-on"), true);
  plain.api.setFeedbackMode(false);
  assert.equal(parts(plain).tuck.classList.contains("pl-mode-on"), false);

  const widget = widgetHarness({ storage: new Map([[LAUNCHER_KEY, "tab"]]) });
  widget.init();
  widget.api.setFeedbackMode(true);
  const { tab } = parts(widget);
  assert.equal(shown(widget), "tab");
  assert.equal(tab.classList.contains("pl-mode-on"), true);
  const stop = widget.document.querySelector("[data-pl-stop-capture]");
  stop.focus();
  widget.document.emit("keydown", { key: "Escape", target: stop });
  assert.equal(widget.document.querySelector("[data-pl-capture-guide]").hidden, true);
  assert.equal(tab.classList.contains("pl-mode-on"), false);
  assert.ok(widget.document.activeElement === tab, "focus returns to the tab");
});
