"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The review target at a position that the test moves, inside a box that cuts
// off what overflows it (overflow-y: auto) when `scrolls` is set.
function page({ scrolls = true } = {}) {
  const widget = widgetHarness();
  const offset = { x: 0, y: 0 };
  widget.target.getBoundingClientRect = () => ({
    left: offset.x, top: offset.y, right: offset.x + 200, bottom: offset.y + 100, width: 200, height: 100
  });
  const box = widget.document.createElement("div");
  box.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 });
  widget.target.remove();
  box.append(widget.target);
  widget.document.body.append(box);
  widget.window.getComputedStyle = (node) => ({ overflowX: "visible", overflowY: scrolls && node === box ? "auto" : "visible" });
  return { widget, offset, box };
}

// Markers are placed by left / top (a pin is centred on them); the fake DOM
// has no layout, so a marker reports the box its style gives it.
function laidOut(node) {
  node.getBoundingClientRect = () => {
    const left = parseFloat(node.style.left);
    const top = parseFloat(node.style.top);
    if (node.matches("[data-patchloop-area]")) {
      const width = parseFloat(node.style.width);
      const height = parseFloat(node.style.height);
      return { left, top, right: left + width, bottom: top + height, width, height };
    }
    return { left: left - 15, top: top - 15, right: left + 15, bottom: top + 15, width: 30, height: 30 };
  };
  return node;
}

function at(node) {
  return `${node.style.left} ${node.style.top}`;
}

test("a marker in a box that scrolls inside the page follows its element and hides once the element leaves the box (#213)", async () => {
  const { widget, offset, box } = page();
  widget.init();
  await widget.submit("Inside the box");
  const pin = laidOut(widget.document.querySelector("[data-patchloop-pin]"));
  assert.equal(at(pin), "20px 30px");

  offset.y = -20;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(at(pin), "20px 10px");
  assert.equal(pin.classList.contains("pl-marker-clipped"), false);

  offset.y = -120;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(pin.classList.contains("pl-marker-clipped"), true, "out of the box: hidden");
  assert.equal(at(pin), "20px 10px", "a hidden marker is not carried off (it would stretch the page)");

  offset.y = 0;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(at(pin), "20px 30px");
  assert.equal(pin.classList.contains("pl-marker-clipped"), false, "back in the box: shown");

  // Only the marker moved: the comment keeps the place as confirmed (#155).
  const target = widget.api.getFeedback()[0].target;
  assert.deepEqual([target.clientX, target.clientY, target.pageX, target.pageY], [20, 30, 20, 30]);
  widget.api.destroy();
});

test("content moved by a transform: a wheel or a drag puts the marker back on its element, a plain move does not (#213)", async () => {
  const { widget, offset } = page({ scrolls: false });
  widget.init();
  await widget.submit("On a canvas");
  const pin = laidOut(widget.document.querySelector("[data-patchloop-pin]"));

  offset.x = 50;
  widget.document.emit("wheel", { target: widget.target });
  await sleep(60);
  assert.equal(at(pin), "70px 30px");
  // Following stops a moment after the last event.
  await sleep(500);

  offset.x = 0;
  widget.document.emit("mousemove", { target: widget.target, buttons: 0 });
  await sleep(100);
  assert.equal(at(pin), "70px 30px", "a move without a button held is not a drag");

  widget.document.emit("mousemove", { target: widget.target, buttons: 1 });
  await sleep(60);
  assert.equal(at(pin), "20px 30px");
  // No box cuts it off: the marker stays shown wherever it goes.
  assert.equal(pin.classList.contains("pl-marker-clipped"), false);
  widget.api.destroy();
});

test("the number of a place being commented on follows, and an area is cut down to the box (#213)", async () => {
  const { widget, offset, box } = page();
  widget.init();
  widget.capture();
  const pending = laidOut(widget.document.querySelector("[data-patchloop-pin]"));
  assert.equal(at(pending), "20px 30px");
  offset.y = -10;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(at(pending), "20px 20px", "the pin of the open comment form follows");
  widget.document.querySelector("[data-pl-comment]").emit("keydown", { key: "Escape" });

  offset.y = 0;
  await widget.submit("An area", { area: true });
  const area = laidOut(widget.document.querySelector("[data-patchloop-area]"));
  assert.equal(at(area), "20px 30px");
  offset.y = -50;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(`${at(area)} ${area.style.width} ${area.style.height}`, "20px 0px 80px 30px", "cut down to the part in the box");
  assert.equal(area.classList.contains("pl-marker-clipped"), false);

  offset.y = -200;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(area.classList.contains("pl-marker-clipped"), true, "wholly out of the box: hidden");
  widget.api.destroy();
});

test("a hidden marker takes no room, and a change of what cuts it off is picked up after a resize (#213)", async () => {
  const { widget, offset, box } = page();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  assert.match(css, /\[data-patchloop-pin\]\.pl-marker-clipped, \[data-patchloop-area\]\.pl-marker-clipped \{ display: none !important; \}/);
  await widget.submit("Inside the box");
  const pin = laidOut(widget.document.querySelector("[data-patchloop-pin]"));
  offset.y = -120;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(pin.classList.contains("pl-marker-clipped"), true);

  // The box stops cutting off (overflow: visible): the marker shows where its element is.
  widget.window.getComputedStyle = () => ({ overflowX: "visible", overflowY: "visible" });
  widget.window.emit("resize");
  await sleep(300);
  assert.equal(pin.classList.contains("pl-marker-clipped"), false);
  assert.equal(at(pin), "20px -90px");
  widget.api.destroy();
});

// requestAnimationFrame and the clock under the test's control.
function frames(widget) {
  const queued = new Map();
  let next = 1;
  const clock = { now: 0 };
  widget.window.requestAnimationFrame = (callback) => {
    queued.set(next, callback);
    return next++;
  };
  widget.window.cancelAnimationFrame = (id) => queued.delete(id);
  widget.window.performance = { now: () => clock.now };
  return {
    clock,
    get queued() { return queued.size; },
    step(ms = 16) {
      clock.now += ms;
      const due = [...queued.values()];
      queued.clear();
      due.forEach((callback) => callback(clock.now));
    }
  };
}

test("following runs on animation frames: it stops once nothing moves, and after two seconds of motion at the latest (#213)", async () => {
  const { widget, offset, box } = page();
  const frame = frames(widget);
  widget.init();
  await widget.submit("Inside the box");
  const pin = laidOut(widget.document.querySelector("[data-patchloop-pin]"));
  while (frame.queued) frame.step();

  offset.y = -20;
  widget.document.emit("scroll", { target: box });
  assert.equal(frame.queued, 1, "one frame asked for");
  frame.step();
  assert.equal(at(pin), "20px 10px");
  let steps = 0;
  while (frame.queued && steps < 1000) {
    frame.step();
    steps += 1;
  }
  assert.ok(steps > 0 && steps < 40, `stops shortly after it settles (${steps} frames)`);

  // Content that never stops moving: following gives up two seconds after the event.
  const startedAt = frame.clock.now;
  widget.document.emit("scroll", { target: box });
  steps = 0;
  while (frame.queued && steps < 1000) {
    offset.y = offset.y === -20 ? -21 : -20;
    frame.step();
    steps += 1;
  }
  assert.equal(frame.queued, 0);
  assert.ok(frame.clock.now - startedAt <= 2000 + 16, `stopped at ${frame.clock.now - startedAt}ms`);
  widget.api.destroy();
});

test("destroy and a re-init drop a frame asked for (#213)", async () => {
  const { widget, box } = page();
  const frame = frames(widget);
  widget.init();
  await widget.submit("Inside the box");
  while (frame.queued) frame.step();

  widget.document.emit("scroll", { target: box });
  assert.equal(frame.queued, 1);
  widget.api.destroy();
  assert.equal(frame.queued, 0, "destroy cancels it");

  // The harness keeps no comments over an init (persistFeedback: false).
  widget.init();
  await widget.submit("After the re-init");
  while (frame.queued) frame.step();
  widget.document.emit("scroll", { target: box });
  assert.equal(frame.queued, 1);
  widget.init();
  // The re-init cancels the earlier frame; it may ask for one of its own.
  assert.ok(frame.queued <= 1);
  while (frame.queued) frame.step();
  widget.api.destroy();
});

test("an area dragged across items of a scrolling box is anchored inside the box, so it moves with them (#213)", async () => {
  const { widget, offset, box } = page();
  // An item smaller than the area: the anchor climbs from it, but not up to the box.
  widget.target.getBoundingClientRect = () => ({
    left: offset.x, top: offset.y, right: offset.x + 60, bottom: offset.y + 40, width: 60, height: 40
  });
  widget.init();
  await widget.submit("Across the items", { area: true });
  const anchor = widget.api.getFeedback()[0].target.anchor;
  assert.equal(anchor.selector, "#review-target");
  const area = laidOut(widget.document.querySelector("[data-patchloop-area]"));
  assert.equal(at(area), "20px 30px");
  offset.y = -10;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(at(area), "20px 20px");
  widget.api.destroy();
});

test("an area left as a thin strip at the box's edge cuts off its number too (#213)", async () => {
  const { widget, offset, box } = page();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  assert.match(css, /\[data-patchloop-area\]\.pl-marker-cut \{ overflow: hidden !important; \}/);
  await widget.submit("An area", { area: true });
  const area = laidOut(widget.document.querySelector("[data-patchloop-area]"));
  assert.equal(area.classList.contains("pl-marker-cut"), false);
  // 4px of the area's 50 left in the box: the 30px number would stick out of it.
  offset.y = -76;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(`${at(area)} ${area.style.height}`, "20px 0px 4px");
  assert.equal(area.classList.contains("pl-marker-cut"), true);
  offset.y = 0;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(area.classList.contains("pl-marker-cut"), false, "whole again: not cut");
  widget.api.destroy();
});

test("a drag whose centre lands on the scrolling box itself is anchored to the item it starts on (#213)", async () => {
  const { widget, box } = page();
  // The area runs from (20, 30) to (100, 80): its centre (60, 55) falls in a gap, on the box.
  widget.document.elementFromPoint = (x, y) => (x === 60 && y === 55 ? box : widget.target);
  widget.init();
  await widget.submit("Between items", { area: true });
  assert.equal(widget.api.getFeedback()[0].target.anchor.selector, "#review-target");
  widget.api.destroy();
});

test("a drag from the box's gap back onto an item is anchored to the item it ends on (#213)", async () => {
  const { widget, box } = page();
  // Dragged from (100, 80), in a gap of the box, up to (20, 30) on the item:
  // only the point it ends on is the item.
  widget.document.elementFromPoint = (x, y) => (x === 20 && y === 30 ? widget.target : box);
  widget.init();
  widget.api.setFeedbackMode(true);
  const document = widget.document;
  document.emit("mousedown", { target: box, button: 0, clientX: 100, clientY: 80 });
  document.emit("mousemove", { target: box, buttons: 1, clientX: 20, clientY: 30 });
  document.emit("mouseup", { target: widget.target, button: 0, clientX: 20, clientY: 30 });
  document.querySelector("[data-pl-comment-text]").value = "Dragged backwards";
  document.querySelector("[data-pl-reviewer]").value = "Reviewer";
  await Promise.all(document.querySelector("[data-pl-comment]").emit("submit"));
  assert.equal(widget.api.getFeedback()[0].target.anchor.selector, "#review-target");
  widget.api.destroy();
});

test("the number of a place being commented on is placed and hidden by the same element after it is replaced (#213)", async () => {
  const { widget, box } = page();
  widget.init();
  widget.capture();
  const pending = laidOut(widget.document.querySelector("[data-patchloop-pin]"));
  // The page renders the item anew: same id, new element, the old one gone.
  const fresh = widget.document.createElement("button");
  fresh.id = "review-target";
  const offset = { y: 0 };
  fresh.getBoundingClientRect = () => ({ left: 0, top: offset.y, right: 200, bottom: offset.y + 100, width: 200, height: 100 });
  widget.target.remove();
  box.append(fresh);

  offset.y = -120;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(pending.classList.contains("pl-marker-clipped"), true, "the new element left the box: hidden");
  offset.y = -10;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(pending.classList.contains("pl-marker-clipped"), false);
  assert.equal(at(pending), "20px 20px");
  widget.api.destroy();
});

