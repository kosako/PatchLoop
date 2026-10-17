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
  assert.equal(at(pin), "20px -90px");
  assert.equal(pin.classList.contains("pl-marker-clipped"), true, "out of the box: hidden");

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
  assert.equal(at(area), "20px -20px");
  assert.equal(area.style.clipPath, "inset(20px 0px 0px 0px)", "the part above the box is cut off");
  assert.equal(area.classList.contains("pl-marker-clipped"), false);

  offset.y = -200;
  widget.document.emit("scroll", { target: box });
  await sleep(60);
  assert.equal(area.classList.contains("pl-marker-clipped"), true, "wholly out of the box: hidden");
  widget.api.destroy();
});
