"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MISSING = "対象の要素が見つからないため、保存した位置に表示しています";
const VIEWPORT = "ウィンドウサイズが変わったため、位置が近似になっています";

// The ≈ of the one comment: on its marker and in the list, "" when none.
function approximate(widget) {
  const marker = widget.document.querySelector("[data-patchloop-pin]");
  const badge = widget.document.querySelector(".pl-feedback-approx");
  const onMarker = marker.classList.contains("pl-marker-approx") ? marker.title : "";
  const inList = badge ? badge.getAttribute("title") : "";
  assert.equal(onMarker, inList, "the marker and the list say the same");
  return onMarker;
}

test("a comment whose element cannot be found gets the ≈ for that reason, even at the same window size (#200)", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("On the item");
  assert.equal(approximate(widget), "");

  widget.target.remove();
  widget.window.emit("resize");
  await sleep(260);
  assert.equal(approximate(widget), MISSING);

  widget.document.body.append(widget.target);
  widget.window.emit("resize");
  await sleep(260);
  assert.equal(approximate(widget), "");
  widget.api.destroy();
});

test("an element of no size counts as not found (#200)", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("On the item");
  widget.target.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  widget.window.emit("resize");
  await sleep(260);
  assert.equal(approximate(widget), MISSING);
  widget.api.destroy();
});

test("a comment made on no element gets the ≈ only when the window size differs, with that reason (#200)", async () => {
  const widget = widgetHarness();
  // Wider than the viewport: not anchored to.
  widget.target.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100 });
  widget.init();
  await widget.submit("On a wide element");
  assert.equal(widget.api.getFeedback()[0].target.anchor, null);
  widget.window.emit("resize");
  await sleep(260);
  assert.equal(approximate(widget), "", "same window size: the stored place holds");

  widget.window.innerWidth = 900;
  widget.window.emit("resize");
  await sleep(260);
  assert.equal(approximate(widget), VIEWPORT);
  widget.api.destroy();
});

test("a page that draws the element after the widget starts: the marker is placed on it within the first seconds (#200)", async () => {
  const storage = new Map();
  const options = { persistFeedback: true, deliveryMode: "download" };
  const before = widgetHarness({ storage });
  before.init(options);
  await before.submit("Drawn late");
  before.api.destroy();

  const widget = widgetHarness({ storage });
  widget.target.remove();
  widget.init(options);
  assert.equal(approximate(widget), MISSING);
  await sleep(700);
  widget.document.body.append(widget.target);
  await sleep(1100);
  assert.equal(approximate(widget), "", "found on a later try");
  widget.api.destroy();
});

test("the tries stop after the first seconds; a marker followed onto its element later loses the ≈ (#200)", async () => {
  const storage = new Map();
  const options = { persistFeedback: true, deliveryMode: "download" };
  const before = widgetHarness({ storage });
  before.init(options);
  await before.submit("Drawn very late");
  before.api.destroy();

  const widget = widgetHarness({ storage });
  widget.target.remove();
  widget.init(options);
  // The last try is at 3 seconds; the following it starts settles soon after.
  await sleep(3700);
  widget.document.body.append(widget.target);
  await sleep(1700);
  assert.equal(approximate(widget), MISSING, "no more tries");

  // Something moves on the page (#213): the marker is put on its element.
  widget.document.emit("scroll", { target: widget.document });
  await sleep(100);
  assert.equal(approximate(widget), "");
  widget.api.destroy();
});
