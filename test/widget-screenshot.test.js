"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// byteLength probes window.Blob before constructing a Blob; node has a global
// Blob but no window, so expose it (node --test isolates globals per file).
globalThis.window = { Blob: globalThis.Blob };

const { byteLength, base64Encode, snapshotScrollStyle } = require("../widget/src/screenshot.js");

test("snapshotScrollStyle offsets the body without a transform so fixed and sticky elements stay in view (#171)", () => {
  const style = snapshotScrollStyle(12.4, 499.6);
  // A transform would make the body the containing block of position:fixed
  // descendants and push them out of the snapshot.
  assert.doesNotMatch(style, /transform/);
  assert.match(style, /position:relative !important;/);
  assert.match(style, /left:-12px !important;/);
  assert.match(style, /top:-500px !important;/);
  // Keeps the body a stacking context, so negative z-index children are not
  // painted under its background.
  assert.match(style, /z-index:0 !important;/);
  assert.equal(snapshotScrollStyle(0, 0), "position:relative !important;left:0px !important;top:0px !important;z-index:0 !important;");
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
