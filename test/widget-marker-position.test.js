"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Moves where an absolute child of body at left/top 0 lands: every element
// created from here on reports it as its client rect.
function probeOrigin(widget, left, top) {
  const createElement = widget.document.createElement;
  widget.document.createElement = (tagName) => Object.assign(createElement(tagName), {
    getBoundingClientRect: () => ({ left, top, right: left, bottom: top, width: 0, height: 0 })
  });
}

// #173: a scroll-locked modal sets body { position: fixed; top: -<scroll>px },
// which makes body the containing block of the absolute markers while
// window.scrollY reads 0.
const lockBody = (widget, top) => probeOrigin(widget, 0, top);

const marker = (widget, selector) => widget.document.querySelector(selector);

test("markers on a scroll-locked body are offset by the body's origin; stored coordinates are not", async () => {
  const widget = widgetHarness();
  widget.init();
  lockBody(widget, -500);

  await widget.submit("pin while locked");
  const pin = marker(widget, "[data-patchloop-pin]");
  assert.deepEqual([pin.style.left, pin.style.top], ["20px", "530px"]);

  await widget.submit("area while locked", { area: true });
  const area = marker(widget, "[data-patchloop-area]");
  assert.deepEqual(
    [area.style.left, area.style.top, area.style.width, area.style.height],
    ["20px", "530px", "80px", "50px"]
  );

  const targets = widget.api.getFeedback().map((item) => item.target);
  const pinTarget = targets.find((target) => target.kind !== "area");
  const areaTarget = targets.find((target) => target.kind === "area");
  assert.deepEqual([pinTarget.pageX, pinTarget.pageY], [20, 30]);
  assert.deepEqual([areaTarget.area.pageX, areaTarget.area.pageY], [20, 30]);
});

test("markers on a static body keep left/top equal to the page coordinates", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("static body", { area: true });
  const area = marker(widget, "[data-patchloop-area]");
  assert.deepEqual([area.style.left, area.style.top], ["20px", "30px"]);
  const target = widget.api.getFeedback()[0].target;
  assert.deepEqual([target.area.pageX, target.area.pageY], [20, 30]);
});

test("markers on a scrolled static body subtract the scroll and the origin, so left/top equal the page coordinates", async () => {
  const widget = widgetHarness();
  widget.init();
  // A static body scrolled by (100, 500): its absolute children at left/top 0
  // land at the document origin, (-100, -500) on screen.
  Object.assign(widget.window, { scrollX: 100, scrollY: 500 });
  probeOrigin(widget, -100, -500);

  await widget.submit("pin on a scrolled page");
  const pin = marker(widget, "[data-patchloop-pin]");
  assert.deepEqual([pin.style.left, pin.style.top], ["120px", "530px"]);
  await widget.submit("area on a scrolled page", { area: true });
  const area = marker(widget, "[data-patchloop-area]");
  assert.deepEqual([area.style.left, area.style.top], ["120px", "530px"]);

  const targets = widget.api.getFeedback().map((item) => item.target);
  const pinTarget = targets.find((target) => target.kind !== "area");
  const areaTarget = targets.find((target) => target.kind === "area");
  assert.deepEqual([pinTarget.pageX, pinTarget.pageY], [120, 530]);
  assert.deepEqual([areaTarget.area.pageX, areaTarget.area.pageY], [120, 530]);
});

test("a re-anchor while the body is locked places existing markers against the locked body", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("before lock");
  const pin = marker(widget, "[data-patchloop-pin]");
  assert.equal(pin.style.top, "30px");

  lockBody(widget, -500);
  widget.window.emit("resize");
  await sleep(260);
  assert.equal(pin.style.left, "20px");
  assert.equal(pin.style.top, "530px");
  const target = widget.api.getFeedback()[0].target;
  assert.deepEqual([target.pageX, target.pageY], [20, 30]);
});
