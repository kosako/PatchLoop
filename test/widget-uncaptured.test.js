"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectUncaptured, WIDGET_NODES } = require("../widget/src/uncaptured.js");

// Plain stand-ins for elements: tag, box ([left, top, width, height]), children
// and an optional open shadow root. Results hold no element references, so
// they are compared as plain data.
function el(tag, { box = [0, 0, 0, 0], children = [], shadow = null, widget = false } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    children,
    shadowRoot: shadow ? { children: shadow } : null,
    getBoundingClientRect: () => ({ left: box[0], top: box[1], right: box[0] + box[2], bottom: box[1] + box[3] }),
    matches: (selector) => widget && selector === WIDGET_NODES,
    contains: (other) => other === node || children.some((child) => child.contains(other))
  };
  return node;
}

const VIEWPORT = { width: 800, height: 600 };
const POINT = { kind: "point", x: 400, y: 300 };
const nothingOnTop = () => null;

test("each kind of element the snapshot cannot draw is detected with its box clipped to the viewport", () => {
  const body = el("body", {
    box: [0, 0, 800, 2000],
    children: [
      el("canvas", { box: [10, 10, 100, 50] }),
      el("section", { box: [0, 100, 800, 400], children: [el("iframe", { box: [-20, 120, 100, 50] })] }),
      el("frame", { box: [700, 550, 200, 200] }),
      el("embed", { box: [200, 10, 40, 40] }),
      el("object", { box: [250, 10, 40, 40] }),
      el("video", { box: [300, 10, 40, 40] }),
      el("my-widget", { box: [350, 10, 40, 40], shadow: [el("div", { box: [350, 10, 40, 40] })] })
    ]
  });
  const result = detectUncaptured(body, VIEWPORT, POINT, nothingOnTop);
  assert.equal(result.version, 1);
  assert.equal(result.status, "detected");
  assert.equal(result.scanTruncated, false);
  assert.deepEqual(result.counts, { "shadow-host": 1, canvas: 1, frame: 2, embed: 2, video: 1 });
  assert.deepEqual(result.regions.map(({ kind, tag, rects }) => [kind, tag, rects]), [
    ["canvas", "canvas", [{ x: 10, y: 10, width: 100, height: 50 }]],
    ["frame", "iframe", [{ x: 0, y: 120, width: 80, height: 50 }]],
    ["frame", "frame", [{ x: 700, y: 550, width: 100, height: 50 }]],
    ["embed", "embed", [{ x: 200, y: 10, width: 40, height: 40 }]],
    ["embed", "object", [{ x: 250, y: 10, width: 40, height: 40 }]],
    ["video", "video", [{ x: 300, y: 10, width: 40, height: 40 }]],
    ["shadow-host", "my-widget", [{ x: 350, y: 10, width: 40, height: 40 }]]
  ]);
});

test("elements without a box in the viewport and other elements are not reported", () => {
  // The div also stands for the host of a closed shadow root, whose shadowRoot
  // reads as null from the page.
  const body = el("body", {
    children: [
      el("canvas", { box: [10, 10, 0, 0] }),
      el("iframe", { box: [10, 700, 100, 50] }),
      el("video", { box: [-200, 10, 100, 50] }),
      el("div", { box: [0, 0, 800, 600] }),
      el("img", { box: [0, 0, 100, 100] })
    ]
  });
  const result = detectUncaptured(body, VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions, []);
  assert.deepEqual(result.counts, { "shadow-host": 0, canvas: 0, frame: 0, embed: 0, video: 0 });
  assert.equal(result.scannedElements, 6);
});

test("a shadow host is placed by the first boxes in its shadow tree, past zero-size wrappers", () => {
  // Like Next.js: a zero-size <nextjs-portal>, style elements, and a zero-size
  // fixed wrapper around the visible badge.
  const portal = el("nextjs-portal", {
    shadow: [
      el("style"),
      el("div", { box: [20, 580, 0, 0], children: [el("div", { box: [20, 540, 40, 40], children: [el("span", { box: [25, 545, 10, 10] })] })] })
    ]
  });
  const result = detectUncaptured(el("body", { children: [portal] }), VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions, [
    { kind: "shadow-host", tag: "nextjs-portal", relation: "none", rects: [{ x: 20, y: 540, width: 40, height: 40 }] }
  ]);
});

test("a shadow host keeps at most four boxes, and falls back to its own box when its shadow tree has none", () => {
  const many = el("many-boxes", { shadow: [0, 1, 2, 3, 4, 5].map((i) => el("div", { box: [i * 50, 0, 40, 40] })) });
  const selfPainted = el("self-painted", { box: [0, 100, 300, 60], shadow: [el("style")] });
  const hidden = el("hidden-host", { shadow: [el("div")] });
  const result = detectUncaptured(el("body", { children: [many, selfPainted, hidden] }), VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions.map((region) => [region.tag, region.rects.map((rect) => rect.x)]), [
    ["many-boxes", [0, 50, 100, 150]],
    ["self-painted", [0]]
  ]);
});

test("the fallback content of canvas, frames, embeds and video and the widget's own nodes are not scanned", () => {
  const body = el("body", {
    children: [
      el("object", { box: [0, 0, 100, 100], children: [el("video", { box: [0, 0, 50, 50] })] }),
      el("div", { widget: true, children: [el("canvas", { box: [0, 0, 50, 50] })] })
    ]
  });
  const result = detectUncaptured(body, VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions.map((region) => region.tag), ["object"]);
  assert.equal(result.scannedElements, 3);
});

test("relation: covers when it is on top at the selected spot, overlaps when only the boxes meet", () => {
  const banner = el("iframe", { box: [0, 250, 800, 100] });
  const chart = el("canvas", { box: [350, 280, 100, 100] });
  const aside = el("video", { box: [0, 0, 100, 100] });
  const body = el("body", { children: [banner, chart, aside] });
  const result = detectUncaptured(body, VIEWPORT, POINT, (x, y) => (x === 400 && y === 300 ? banner : null));
  assert.deepEqual(result.regions.map((region) => [region.tag, region.relation]), [
    ["iframe", "covers-target"],
    ["canvas", "overlaps-target"],
    ["video", "none"]
  ]);
});

test("an element inside a detected element on top at the spot also counts as covering it", () => {
  const inner = el("p");
  const object = el("object", { box: [300, 200, 200, 200], children: [inner] });
  const result = detectUncaptured(el("body", { children: [object] }), VIEWPORT, POINT, () => inner);
  assert.equal(result.regions[0].relation, "covers-target");
});

test("an area is probed on a 5 x 5 grid inside the viewport, and overlaps by box intersection", () => {
  const probes = [];
  const video = el("video", { box: [100, 100, 50, 50] });
  const area = { kind: "area", x: 140, y: 140, width: 100, height: 100 };
  const result = detectUncaptured(el("body", { children: [video] }), VIEWPORT, area, (x, y) => {
    probes.push(`${x},${y}`);
    return null;
  });
  assert.equal(probes.length, 25);
  assert.equal(probes[0], "150,150");
  assert.equal(probes[24], "230,230");
  assert.equal(result.regions[0].relation, "overlaps-target");

  probes.length = 0;
  detectUncaptured(el("body"), VIEWPORT, { kind: "area", x: 700, y: 500, width: 150, height: 150 }, (x, y) => {
    probes.push(`${x},${y}`);
    return null;
  });
  // x runs 715 / 745 / 775 / 805 / 835 and y 515 / 545 / 575 / 605 / 635;
  // points at x >= 800 or y >= 600 are off screen, leaving 3 x 3.
  assert.equal(probes.length, 9);
});

test("regions that touch the selected spot are kept first when there are more than twenty", () => {
  const filler = Array.from({ length: 25 }, (_, i) => el("canvas", { box: [i * 10, 0, 5, 5] }));
  const covering = el("iframe", { box: [380, 280, 40, 40] });
  const touching = el("video", { box: [390, 290, 40, 40] });
  const body = el("body", { children: [...filler, touching, covering] });
  const result = detectUncaptured(body, VIEWPORT, POINT, () => covering);
  assert.equal(result.regions.length, 20);
  assert.deepEqual(result.regions.slice(0, 2).map((region) => [region.tag, region.relation]), [
    ["iframe", "covers-target"],
    ["video", "overlaps-target"]
  ]);
  assert.deepEqual(result.counts, { "shadow-host": 0, canvas: 25, frame: 1, embed: 0, video: 1 });
});

test("the scan stops after 20,000 elements and says so", () => {
  const children = Array.from({ length: 20005 }, () => el("div"));
  children[20003] = el("canvas", { box: [0, 0, 10, 10] });
  const result = detectUncaptured(el("body", { children }), VIEWPORT, POINT, nothingOnTop);
  assert.equal(result.scannedElements, 20000);
  assert.equal(result.scanTruncated, true);
  assert.deepEqual(result.regions, []);
});

test("an element with a huge number of children is walked one child at a time and stops at the cap", () => {
  // One shared zero-size child stands in for 200,000: spreading or copying the
  // children up front would build a huge argument list before the cap applies.
  const blank = el("div");
  const wrapper = el("div", { children: new Array(200000).fill(blank) });
  const portal = el("nextjs-portal", { shadow: [wrapper] });
  const result = detectUncaptured(el("body", { children: [portal] }), VIEWPORT, POINT, nothingOnTop);
  assert.equal(result.status, "detected");
  assert.equal(result.scannedElements, 20000);
  assert.equal(result.scanTruncated, true);
});

test("boxes inside a nested open shadow root are found past zero-size hosts", () => {
  const inner = el("inner-part", { shadow: [el("div", { box: [10, 10, 30, 30] })] });
  const outer = el("outer-widget", { shadow: [el("style"), inner] });
  const result = detectUncaptured(el("body", { children: [outer] }), VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions.map((region) => [region.tag, region.rects]), [
    ["outer-widget", [{ x: 10, y: 10, width: 30, height: 30 }]]
  ]);
});

test("rectangles are rounded at their edges, never reach past the viewport, and slivers are dropped", () => {
  const body = el("body", {
    children: [
      el("canvas", { box: [0.5, 0.4, 799.5, 100] }),
      el("video", { box: [10.1, 10, 0.3, 50] })
    ]
  });
  const result = detectUncaptured(body, VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions.map((region) => region.rects), [[{ x: 1, y: 0, width: 799, height: 100 }]]);
  assert.equal(result.counts.video, 0);
});

test("the light DOM of a shadow host is scanned, so a slotted canvas is found even when the host has no box", () => {
  // A display: contents host whose shadow root only holds a slot: neither has
  // a box, but the light DOM canvas assigned to the slot is on screen.
  const slotted = el("canvas", { box: [100, 100, 200, 100] });
  const host = el("chart-frame", { shadow: [el("slot")], children: [slotted] });
  const result = detectUncaptured(el("body", { children: [host] }), VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(result.regions.map((region) => [region.kind, region.tag, region.rects]), [
    ["canvas", "canvas", [{ x: 100, y: 100, width: 200, height: 100 }]]
  ]);

  const boxedHost = el("chart-frame", { box: [0, 0, 400, 300], shadow: [el("slot")], children: [el("canvas", { box: [10, 10, 50, 50] })] });
  const both = detectUncaptured(el("body", { children: [boxedHost] }), VIEWPORT, POINT, nothingOnTop);
  assert.deepEqual(both.regions.map((region) => region.tag), ["chart-frame", "canvas"]);
});
