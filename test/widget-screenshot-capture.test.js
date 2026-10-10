"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { captureScreenshot } = require("../widget/src/screenshot.js");

// captureScreenshot reads the live page through these globals. node --test
// isolates globals per file, so a minimal page is enough to build the SVG and
// check how the cloned body is placed (layout itself needs a real browser).
function installPage({ bodyStyle, bodyInlineStyle = null, scrollX = 0, scrollY = 0, bodyChildren = [], elementsFromPoint = () => [] }) {
  const body = {
    tagName: "BODY",
    children: bodyChildren,
    getAttribute: (name) => (name === "style" ? bodyInlineStyle : null),
    cloneNode: () => ({ childNodes: [], querySelectorAll: () => [] })
  };
  const documentElement = {
    getAttribute: () => null,
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 800,
    scrollHeight: 2000
  };
  globalThis.document = { body, documentElement, styleSheets: [], elementsFromPoint };
  globalThis.window = {
    Blob: globalThis.Blob,
    innerWidth: 800,
    innerHeight: 600,
    scrollX,
    scrollY,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (node) => (node === body
      ? { backgroundColor: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", font: "16px sans-serif", ...bodyStyle }
      : { backgroundColor: "rgba(0, 0, 0, 0)", display: "block" })
  };
  globalThis.XMLSerializer = class {
    serializeToString() {
      return "";
    }
  };
}

function capturedBodyStyle() {
  const shot = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.equal(shot.status, "captured");
  const svg = Buffer.from(shot.dataUrl.split(",")[1], "base64").toString("utf8");
  const match = svg.match(/<body[^>]*style="([^"]*)"/);
  assert.ok(match, "the snapshot has a body element with an inline style");
  return match[1];
}

test("the snapshot shifts a scrolled static body by positioning it, not with a transform (#171)", () => {
  installPage({ bodyStyle: { position: "static", top: "auto", left: "auto" }, scrollY: 500 });
  const style = capturedBodyStyle();
  assert.doesNotMatch(style, /transform/);
  assert.ok(style.endsWith(
    "position:relative !important;top:-500px !important;left:0px !important;right:auto !important;bottom:auto !important;z-index:auto !important;isolation:isolate !important;"
  ));
});

test("the snapshot keeps a scroll-locked fixed body where the page put it (#171)", () => {
  installPage({
    bodyStyle: { position: "fixed", top: "-500px", left: "0px" },
    bodyInlineStyle: "position: fixed; top: -500px;",
    scrollY: 0
  });
  const style = capturedBodyStyle();
  // The page's inline placement is carried over and nothing overrides it: no
  // transform (fixed descendants such as the modal stay in view) and no
  // position or offset of the snapshot's own.
  assert.ok(style.startsWith("position: fixed; top: -500px;"));
  assert.ok(style.endsWith("isolation:isolate !important;"));
  assert.doesNotMatch(style, /transform|!important;top|position:relative/);
});

// A page element the snapshot cannot draw, as the scan sees it.
function iframeAt(left, top, width, height) {
  const node = {
    tagName: "IFRAME",
    localName: "iframe",
    children: [],
    matches: () => false,
    closest: () => null,
    contains: (other) => other === node,
    getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height })
  };
  return node;
}

test("a captured screenshot records what the image cannot show next to the selected spot (#148)", () => {
  const frame = iframeAt(50, 50, 200, 100);
  installPage({ bodyStyle: { position: "static" }, bodyChildren: [frame], elementsFromPoint: () => [frame] });
  const shot = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.equal(shot.status, "captured");
  assert.equal(shot.uncaptured.status, "detected");
  assert.equal(shot.uncaptured.version, 1);
  assert.deepEqual(shot.uncaptured.regions, [
    { kind: "frame", tag: "iframe", relation: "covers-target", rects: [{ x: 50, y: 50, width: 200, height: 100 }] }
  ]);
});

test("the widget's own nodes on top of the spot are skipped when looking for what covers it (#148)", () => {
  const frame = iframeAt(50, 50, 200, 100);
  const pendingPin = { closest: (selector) => (selector.includes("[data-patchloop-pin]") ? pendingPin : null) };
  installPage({ bodyStyle: { position: "static" }, bodyChildren: [frame], elementsFromPoint: () => [pendingPin, frame] });
  const shot = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.equal(shot.uncaptured.regions[0].relation, "covers-target");
});

test("a failed detection is recorded and still leaves the screenshot captured (#148)", () => {
  installPage({ bodyStyle: { position: "static" }, elementsFromPoint: () => { throw new Error("hit test failed"); } });
  const shot = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.equal(shot.status, "captured");
  assert.deepEqual(shot.uncaptured, { version: 1, status: "failed", error: "hit test failed" });
});

function svgOf(shot) {
  return Buffer.from(shot.dataUrl.split(",")[1], "base64").toString("utf8");
}

test("an element the image cannot show that touches the spot gets a dashed frame and its number (#148)", () => {
  const covering = iframeAt(50, 50, 200, 100);
  const overlapping = iframeAt(90, 60, 100, 300);
  const elsewhere = iframeAt(600, 400, 100, 100);
  installPage({
    bodyStyle: { position: "static" },
    bodyChildren: [elsewhere, overlapping, covering],
    elementsFromPoint: () => [covering]
  });
  const shot = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.deepEqual(shot.uncaptured.regions.map((region) => region.relation), ["covers-target", "overlaps-target", "none"]);
  const svg = svgOf(shot);
  // One white and one dashed rect per frame, for the two that touch the spot.
  assert.equal((svg.match(/stroke-dasharray="6 4"/g) || []).length, 2);
  assert.match(svg, /<rect x="51" y="51" width="198" height="98" fill="none" stroke="#14211d" stroke-width="2" stroke-dasharray="6 4"\/>/);
  assert.match(svg, /<rect x="91" y="61" width="98" height="298" fill="none" stroke="#14211d" stroke-width="2" stroke-dasharray="6 4"\/>/);
  // Numbers sit just above each frame's top-left corner, clear of the spot.
  assert.match(svg, /<rect x="50" y="26" width="20" height="20"/);
  assert.match(svg, /<text x="60" y="40"[^>]*>1<\/text>/);
  assert.match(svg, /<text x="100" y="50"[^>]*>2<\/text>/);
  assert.doesNotMatch(svg, />3<\/text>/);
  // The selected spot's own mark stays on top.
  assert.ok(svg.lastIndexOf("stroke-dasharray") < svg.indexOf('<circle cx="100" cy="100"'));
});

test("no marks are drawn when nothing touches the spot or the detection failed (#148)", () => {
  installPage({ bodyStyle: { position: "static" }, bodyChildren: [iframeAt(600, 400, 100, 100)], elementsFromPoint: () => [] });
  const untouched = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.equal(untouched.uncaptured.regions.length, 1);
  assert.doesNotMatch(svgOf(untouched), /stroke-dasharray/);

  installPage({ bodyStyle: { position: "static" }, elementsFromPoint: () => { throw new Error("hit test failed"); } });
  const failed = captureScreenshot({ kind: "point", pageX: 100, pageY: 100 });
  assert.equal(failed.status, "captured");
  assert.doesNotMatch(svgOf(failed), /stroke-dasharray/);
});

// The numbers' boxes as drawn: 20 x 20 rounded rects.
function numberBoxes(svg) {
  return [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="20" height="20" rx="4"/g)]
    .map(([, x, y]) => ({ x: Number(x), y: Number(y), width: 20, height: 20 }));
}

function meets(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertNumbersPlaced(shot, expectedCount, spotBox, label) {
  const boxes = numberBoxes(svgOf(shot));
  assert.equal(boxes.length, expectedCount, label);
  boxes.forEach((box, i) => {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + 20 <= 800 && box.y + 20 <= 600, `${label}: number ${i + 1} inside the image`);
    assert.equal(meets(box, spotBox), false, `${label}: number ${i + 1} clear of the spot's mark`);
    boxes.slice(i + 1).forEach((other, j) => assert.equal(meets(box, other), false, `${label}: numbers ${i + 1} and ${i + j + 2} apart`));
  });
}

test("numbers stay inside the image and clear of the spot's mark and of each other (#148)", () => {
  for (const [rects, [px, py]] of [
    // A frame filling the image, with the spot at its bottom-left corner.
    [[[0, 0, 800, 600]], [10, 590]],
    // Two frames on the same place.
    [[[50, 50, 200, 100], [50, 50, 200, 100]], [100, 100]],
    // A frame at the top edge, and one in the bottom-right corner.
    [[[100, 5, 200, 40]], [150, 20]],
    [[[790, 590, 10, 10]], [795, 595]]
  ]) {
    const frames = rects.map(([x, y, w, h]) => iframeAt(x, y, w, h));
    installPage({ bodyStyle: { position: "static" }, bodyChildren: frames, elementsFromPoint: () => [frames[0]] });
    const shot = captureScreenshot({ kind: "point", pageX: px, pageY: py });
    assertNumbersPlaced(shot, rects.length, { x: px - 32, y: py - 32, width: 64, height: 64 }, JSON.stringify({ rects, spot: [px, py] }));
  }
});

test("a number keeps clear of an area's badge too (#148)", () => {
  const frame = iframeAt(0, 0, 300, 40);
  installPage({ bodyStyle: { position: "static" }, bodyChildren: [frame], elementsFromPoint: () => [frame] });
  const shot = captureScreenshot({
    kind: "area",
    pageX: 0,
    pageY: 44,
    area: { pageX: 0, pageY: 44, clientWidth: 100, clientHeight: 50 }
  });
  assertNumbersPlaced(shot, 1, { x: 0, y: 44, width: 36, height: 36 }, "area badge below a frame at the top");
});
