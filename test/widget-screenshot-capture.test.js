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
