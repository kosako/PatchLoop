"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// byteLength probes window.Blob before constructing a Blob; node has a global
// Blob but no window, so expose it (node --test isolates globals per file).
globalThis.window = { Blob: globalThis.Blob };

const { byteLength, base64Encode, snapshotBodyOffsetStyle } = require("../widget/src/screenshot.js");

test("snapshotBodyOffsetStyle shifts a static body by the scroll without a transform (#171)", () => {
  const style = snapshotBodyOffsetStyle({ position: "static", top: "auto", left: "auto" }, 12.4, 499.6);
  // A transform would make the body the containing block of position:fixed
  // descendants and push them out of the snapshot. z-index:0 keeps the body a
  // stacking context, so negative z-index children stay above its background.
  assert.equal(
    style,
    "position:relative !important;top:-500px !important;left:-12px !important;right:auto !important;bottom:auto !important;z-index:0 !important;"
  );
  assert.doesNotMatch(style, /transform/);
});

test("snapshotBodyOffsetStyle keeps a positioned body's own offsets (#171)", () => {
  // Scroll locking under a modal: the fixed body carries the scroll offset and
  // window.scrollY is 0; a fixed body never moves with the document scroll.
  assert.match(
    snapshotBodyOffsetStyle({ position: "fixed", top: "-500px", left: "0px" }, 0, 0),
    /^position:fixed !important;top:-500px !important;left:0px !important;/
  );
  assert.match(
    snapshotBodyOffsetStyle({ position: "fixed", top: "-500px", left: "0px" }, 0, 300),
    /^position:fixed !important;top:-500px !important;left:0px !important;/
  );
  assert.match(
    snapshotBodyOffsetStyle({ position: "relative", top: "10px", left: "4px" }, 0, 300),
    /^position:relative !important;top:-290px !important;left:4px !important;/
  );
  assert.match(
    snapshotBodyOffsetStyle({ position: "absolute", top: "20px", left: "0px" }, 0, 100),
    /^position:absolute !important;top:-80px !important;left:0px !important;/
  );
  // A sticky body's top is a threshold, not an offset.
  assert.match(
    snapshotBodyOffsetStyle({ position: "sticky", top: "0px", left: "auto" }, 0, 100),
    /^position:relative !important;top:-100px !important;left:0px !important;/
  );
});

test("snapshotBodyOffsetStyle clears right so it cannot cancel the horizontal scroll in RTL pages (#171)", () => {
  const style = snapshotBodyOffsetStyle({ position: "relative", top: "0px", left: "0px", right: "0px" }, -500, 0);
  assert.match(style, /left:500px !important;right:auto !important;bottom:auto !important;/);
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
