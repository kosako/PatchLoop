"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// byteLength probes window.Blob before constructing a Blob; node has a global
// Blob but no window, so expose it (node --test isolates globals per file).
globalThis.window = { Blob: globalThis.Blob };

const { byteLength, base64Encode } = require("../widget/src/screenshot.js");

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
