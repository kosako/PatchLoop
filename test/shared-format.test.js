"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  truncateText,
  present,
  escapeHtml,
  escapeXml,
  slackEscape,
  formatSlackCode,
  formatSlackLink,
  formatViewport,
  formatTarget
} = require("../shared/format.js");

test("truncateText coerces and appends an ellipsis past the limit", () => {
  assert.equal(truncateText("hello", 10), "hello");
  assert.equal(truncateText("hello world", 5), "hello…");
  assert.equal(truncateText(null, 5), "");
  assert.equal(truncateText(12345678, 4), "1234…");
});

test("present substitutes ? for empty values only", () => {
  assert.equal(present("x"), "x");
  assert.equal(present(0), 0);
  assert.equal(present(false), false);
  assert.equal(present(""), "?");
  assert.equal(present(null), "?");
  assert.equal(present(undefined), "?");
});

test("escapeHtml escapes markup characters and keeps falsy non-nullish values", () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("escapeXml additionally escapes single quotes", () => {
  assert.equal(escapeXml("it's <b>"), "it&apos;s &lt;b&gt;");
});

test("slackEscape escapes Slack mrkdwn control characters", () => {
  assert.equal(slackEscape("<&>"), "&lt;&amp;&gt;");
  assert.equal(slackEscape(null), "");
});

test("formatSlackCode wraps in backticks, replaces inner backticks, truncates at 180", () => {
  assert.equal(formatSlackCode("a`b"), "`a'b`");
  const long = formatSlackCode("x".repeat(200));
  assert.ok(long.startsWith("`"));
  assert.ok(long.endsWith("…`"));
  assert.equal(long.length, 180 + 3); // 180 chars + ellipsis + 2 backticks
});

test("formatSlackLink links http(s) URLs and degrades to escaped text otherwise", () => {
  assert.equal(formatSlackLink("https://a.test/x", "Label"), "<https://a.test/x|Label>");
  // pipe would terminate the Slack link syntax
  assert.equal(formatSlackLink("https://a.test/x", "a|b"), "<https://a.test/x|a/b>");
  // label falls back to the URL
  assert.equal(formatSlackLink("https://a.test/x", ""), "<https://a.test/x|https://a.test/x>");
  // non-http schemes never become links
  assert.equal(formatSlackLink("javascript:alert(1)", "click"), "click");
  assert.equal(formatSlackLink(null, "page title"), "page title");
  assert.equal(formatSlackLink(null, null), "(unknown)");
});

test("formatViewport renders width x height with placeholders", () => {
  assert.equal(formatViewport({ width: 1024, height: 768 }), "1024x768");
  assert.equal(formatViewport({ width: 1024 }), "1024x?");
  assert.equal(formatViewport(null), "(unknown)");
});

test("formatTarget describes points and areas", () => {
  assert.equal(formatTarget({ kind: "point", clientX: 10, clientY: 20 }), "point at 10,20");
  assert.equal(formatTarget({}), "point at ?,?");
  assert.equal(
    formatTarget({ kind: "area", area: { clientWidth: 100, clientHeight: 50, clientX: 5, clientY: 6 } }),
    "area 100x50 at 5,6"
  );
  // area kind without area payload falls back to point formatting
  assert.equal(formatTarget({ kind: "area", clientX: 1, clientY: 2 }), "area at 1,2");
});
