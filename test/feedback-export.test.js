"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { feedbackForExport } = require("../server/feedback-export.js");

test("feedback export removes only screenshot.path without mutating its input", () => {
  const screenshot = Object.freeze({ path: "internal-image-file", url: "https://receiver.example/screenshots/a.svg", bytes: 42 });
  const item = Object.freeze({ id: "feedback", screenshot, extra: { path: "public-source-file" }, sourceContext: { root: "web" } });
  const exported = feedbackForExport(item);
  assert.deepEqual(exported, {
    id: "feedback", screenshot: { url: screenshot.url, bytes: 42 },
    extra: item.extra, sourceContext: item.sourceContext
  });
  assert.equal(item.screenshot.path, "internal-image-file");
  assert.notEqual(exported, item);
  assert.notEqual(exported.screenshot, screenshot);
});

test("feedback without an internal screenshot path keeps its payload intact", () => {
  for (const item of [{ id: "none" }, { id: "null", screenshot: null }, { id: "omitted", screenshot: { status: "omitted", reason: "too-large" } }]) {
    assert.equal(feedbackForExport(item), item);
  }
});
