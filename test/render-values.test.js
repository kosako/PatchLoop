"use strict";

// The pure helpers the receiver and the inbox view render values with (#170).

const assert = require("node:assert/strict");
const test = require("node:test");
const { safeLinkUrl, mdLinkUrl, formatScreenshotStatus } = require("../server/render-values.js");

test("only http(s) URLs become links", () => {
  assert.equal(safeLinkUrl("https://example.test/page"), "https://example.test/page");
  assert.equal(safeLinkUrl("  HTTP://example.test/  "), "HTTP://example.test/");
  for (const value of ["javascript:alert(1)", "data:text/html,x", "/relative", "example.test", "", null, undefined]) {
    assert.equal(safeLinkUrl(value), "", String(value));
  }
});

test("a Markdown link destination cannot break out of its <> form", () => {
  assert.equal(mdLinkUrl("https://example.test/a b<c>d\te"), "<https://example.test/a%20b%3Cc%3Ed%20e>");
  assert.equal(mdLinkUrl("javascript:alert(1)"), "");
});

test("the screenshot status texts", () => {
  assert.equal(formatScreenshotStatus(undefined), "none");
  assert.equal(formatScreenshotStatus({ status: "omitted", reason: "too-large", bytes: 2048, maxBytes: 1024 }), "omitted: 2048 bytes exceeds 1024");
  assert.equal(formatScreenshotStatus({ status: "saved", bytes: 512 }), "saved (512 bytes)");
  assert.equal(formatScreenshotStatus({ status: "failed" }), "failed");
  assert.equal(formatScreenshotStatus({}), "unknown");
});
