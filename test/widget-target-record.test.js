"use strict";

// A comment's target is the record of when it was confirmed (#155), like
// environment.viewport and the screenshot: confirming takes the scroll of that
// moment, and a later re-anchor moves only the marker.

const assert = require("node:assert/strict");
const test = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { widgetHarness } = require("../test-support/widget-dom.js");

// The page reflows at a narrower window: the target element moves to (100, 200).
async function reflow(w) {
  w.target.getBoundingClientRect = () => ({ left: 100, top: 200, right: 300, bottom: 300, width: 200, height: 100 });
  w.window.innerWidth = 500;
  w.document.documentElement.clientWidth = 500;
  w.window.emit("resize");
  await sleep(260);
}

const position = (node) => [node.style.left, node.style.top];
// The widget's objects come from another realm; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const targets = (w) => plain(w.api.getFeedback().map((item) => item.target));

// The screenshot marks the spot at its page position minus the scroll of the
// moment it is taken (screenshotOverlayFor), which is when the comment is confirmed.
test("confirming after a scroll records the viewport position of that moment", async () => {
  const w = widgetHarness();
  w.init();
  w.window.scrollY = 100;
  w.capture();
  w.window.scrollY = 20;
  await w.submit("Scrolled before sending", { captureTarget: false });

  const { target } = JSON.parse(w.requests[0].body);
  assert.deepEqual([target.clientX, target.clientY, target.pageX, target.pageY], [20, 110, 20, 130]);
  assert.equal(target.y, 18.3);
});

test("an area confirmed after a scroll records its viewport position of that moment", async () => {
  const w = widgetHarness();
  w.init();
  w.window.scrollY = 100;
  w.capture(true);
  w.window.scrollY = 20;
  await w.submit("Scrolled before sending", { captureTarget: false });

  const { target } = JSON.parse(w.requests[0].body);
  assert.deepEqual([target.clientY, target.pageY], [110, 130]);
  assert.deepEqual([target.area.clientY, target.area.y, target.area.pageY], [110, 18.3, 130]);
});

test("a re-anchor moves the markers but keeps the recorded targets, in storage and in the export", async () => {
  const w = widgetHarness();
  w.init({ persistFeedback: true, deliveryMode: "download" });
  await w.submit("Pin");
  await w.submit("Area", { area: true });
  const recorded = targets(w);

  await reflow(w);
  assert.deepEqual(position(w.document.querySelector("[data-patchloop-pin]")), ["120px", "230px"]);
  const area = w.document.querySelector("[data-patchloop-area]");
  assert.deepEqual([...position(area), area.style.width, area.style.height], ["120px", "230px", "80px", "50px"]);
  assert.deepEqual(targets(w), recorded);

  w.document.querySelector("[data-pl-download-all]").click();
  const bundle = JSON.parse(await w.downloads[0].blob.text());
  assert.deepEqual(plain(bundle.feedback.map((item) => item.target)), recorded);

  // Restoring at the new layout re-anchors the markers again, from the record.
  w.api.destroy();
  w.init({ persistFeedback: true, deliveryMode: "download" });
  assert.deepEqual(targets(w), recorded);
  assert.deepEqual(position(w.document.querySelector("[data-patchloop-pin]")), ["120px", "230px"]);
});

test("a marker whose element is gone returns to the recorded position with the approximate badge", async () => {
  const w = widgetHarness();
  w.init();
  await w.submit("Pin");
  const recorded = targets(w);
  await reflow(w);
  const pin = w.document.querySelector("[data-patchloop-pin]");
  assert.deepEqual(position(pin), ["120px", "230px"]);

  w.target.remove();
  w.window.emit("resize");
  await sleep(260);
  assert.deepEqual(position(pin), ["20px", "30px"]);
  assert.equal(pin.classList.contains("pl-marker-approx"), true);
  assert.deepEqual(targets(w), recorded);
});
