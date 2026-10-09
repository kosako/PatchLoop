"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { captureScreenshot } = require("../widget/src/screenshot.js");

// captureScreenshot reads the live page through these globals. node --test
// isolates globals per file, so a minimal page is enough to build the SVG and
// check how the cloned body is placed (layout itself needs a real browser).
function installPage({ bodyStyle, bodyInlineStyle = null, scrollX = 0, scrollY = 0 }) {
  const body = {
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
  globalThis.document = { body, documentElement, styleSheets: [] };
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
      : { backgroundColor: "rgba(0, 0, 0, 0)" })
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
    "position:relative !important;top:-500px !important;left:0px !important;right:auto !important;bottom:auto !important;z-index:0 !important;"
  ));
});

test("the snapshot keeps a scroll-locked fixed body where the page put it (#171)", () => {
  installPage({
    bodyStyle: { position: "fixed", top: "-500px", left: "0px" },
    bodyInlineStyle: "position: fixed; top: -500px;",
    scrollY: 0
  });
  const style = capturedBodyStyle();
  // The page's inline style is carried over first; the snapshot's placement
  // comes last and reproduces the same offset.
  assert.ok(style.startsWith("position: fixed; top: -500px;"));
  assert.match(style, /position:fixed !important;top:-500px !important;left:0px !important;right:auto !important;/);
});
