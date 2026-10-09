"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// byteLength probes window.Blob before constructing a Blob; node has a global
// Blob but no window, so expose it (node --test isolates globals per file).
globalThis.window = { Blob: globalThis.Blob };

const { byteLength, base64Encode, snapshotBodyOffsetStyle } = require("../widget/src/screenshot.js");

test("snapshotBodyOffsetStyle shifts a static body by relative positioning, not a transform (#171)", () => {
  const style = snapshotBodyOffsetStyle({ position: "static", top: "auto", left: "auto", zIndex: "auto" }, 12.4, 499.6);
  // A transform would make the body the containing block of position:fixed
  // descendants and push them out of the snapshot. z-index:0 keeps the body a
  // stacking context, so negative z-index children stay above its background.
  assert.equal(
    style,
    "position:relative !important;top:-500px !important;left:-12px !important;right:auto !important;bottom:auto !important;z-index:0 !important;"
  );
  // A static body ignores its own z-index, as it did under the transform.
  assert.match(snapshotBodyOffsetStyle({ position: "static", zIndex: "5" }, 0, 100), /z-index:0 !important;$/);
});

test("snapshotBodyOffsetStyle keeps a relative or sticky body's offsets and z-index (#171)", () => {
  assert.equal(
    snapshotBodyOffsetStyle({ position: "relative", top: "10px", left: "4px", zIndex: "auto" }, 0, 300),
    "position:relative !important;top:-290px !important;left:4px !important;right:auto !important;bottom:auto !important;z-index:0 !important;"
  );
  // A z-index the page gave a positioned body keeps its stacking level.
  assert.match(snapshotBodyOffsetStyle({ position: "relative", top: "0px", left: "0px", zIndex: "2" }, 0, 0), /z-index:2 !important;$/);
  // A sticky body's top is a threshold, not an offset.
  assert.match(
    snapshotBodyOffsetStyle({ position: "sticky", top: "0px", left: "auto", zIndex: "auto" }, 0, 100),
    /^position:relative !important;top:-100px !important;left:0px !important;/
  );
  // right is cleared so it cannot cancel the horizontal scroll (RTL pages).
  assert.match(
    snapshotBodyOffsetStyle({ position: "relative", top: "0px", left: "0px", right: "0px", zIndex: "auto" }, -500, 0),
    /left:500px !important;right:auto !important;bottom:auto !important;/
  );
});

test("snapshotBodyOffsetStyle leaves an absolute or fixed body where the page placed it (#171)", () => {
  // Scroll locking under a modal: the fixed body carries the offset itself and
  // the window does not scroll, so the body is not repositioned at all.
  assert.equal(snapshotBodyOffsetStyle({ position: "fixed", top: "-500px", left: "0px", zIndex: "auto" }, 0, 0), "z-index:0 !important;");
  assert.equal(snapshotBodyOffsetStyle({ position: "absolute", top: "20px", left: "0px", zIndex: "3" }, 0, 0), "z-index:3 !important;");
  // A scrolled page keeps the transform: these bodies can size themselves
  // from left + right or sit in a transformed html.
  assert.equal(
    snapshotBodyOffsetStyle({ position: "fixed", top: "0px", left: "100px", zIndex: "auto" }, 0, 500),
    "transform:translate(0px, -500px);transform-origin:top left;"
  );
  assert.equal(
    snapshotBodyOffsetStyle({ position: "absolute", top: "20px", left: "0px", zIndex: "auto" }, 7, 100),
    "transform:translate(-7px, -100px);transform-origin:top left;"
  );
});

test("base64Encode matches Buffer's base64 for ascii and multi-byte text", () => {
  for (const value of ["", "hello", "日本語のテキスト✓", '<svg xmlns="http://www.w3.org/2000/svg">&amp;</svg>']) {
    assert.equal(base64Encode(value), Buffer.from(value, "utf8").toString("base64"));
  }
});

test("base64Encode handles inputs larger than its 8192-byte chunks", () => {
  const value = "svg-content-".repeat(3000);
  assert.equal(base64Encode(value), Buffer.from(value, "utf8").toString("base64"));
});

test("byteLength counts utf-8 bytes via Blob", () => {
  assert.equal(byteLength(""), 0);
  assert.equal(byteLength("hello"), 5);
  assert.equal(byteLength("日本語"), Buffer.byteLength("日本語", "utf8"));
});

test("byteLength falls back to the base64 length without Blob", () => {
  const original = globalThis.window.Blob;
  globalThis.window.Blob = undefined;
  try {
    assert.equal(byteLength("日本語"), base64Encode("日本語").length);
  } finally {
    globalThis.window.Blob = original;
  }
});
