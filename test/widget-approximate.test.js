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
  // Drawn elsewhere than when the comment was made.
  widget.target.getBoundingClientRect = () => ({ left: 100, top: 200, right: 300, bottom: 300, width: 200, height: 100 });
  widget.document.body.append(widget.target);
  await sleep(1100);
  assert.equal(approximate(widget), "", "found on a later try");
  const pin = widget.document.querySelector("[data-patchloop-pin]");
  assert.equal(`${pin.style.left} ${pin.style.top}`, "120px 230px", "put on the element");
  const target = widget.api.getFeedback()[0].target;
  assert.deepEqual([target.clientX, target.clientY], [20, 30], "the comment keeps the place as confirmed (#155)");
  widget.api.destroy();
});

test("tries are asked for only while a listed comment is missing, and none outlives a re-init or destroy (#200)", async () => {
  const storage = new Map();
  const options = { persistFeedback: true, deliveryMode: "download" };
  const before = widgetHarness({ storage });
  before.init(options);
  await before.submit("Missing at first");
  before.api.destroy();

  const delays = [];
  const timers = { setTimeout: (callback, ms) => { delays.push(ms); return setTimeout(callback, ms); }, clearTimeout };
  const widget = widgetHarness({ storage, timers });
  widget.target.remove();
  widget.init(options);
  const tries = () => delays.filter((ms) => ms === 500 || ms === 1000 || ms === 1500).length;
  assert.equal(tries(), 1, "the first try is asked for");

  // A re-init with nothing listed: no comment is missing, so no try.
  widget.init({ deliveryMode: "download", persistFeedback: false });
  assert.equal(tries(), 1);
  await sleep(700);
  assert.equal(tries(), 1, "the earlier try was dropped");

  widget.init(options);
  assert.equal(tries(), 2);
  widget.api.destroy();
  await sleep(700);
  assert.equal(tries(), 2, "destroy drops it too");
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
