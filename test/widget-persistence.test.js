"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// isMatchingFeedbackEnvelope compares the stored pageUrl against
// window.location.href at call time; node has no window, so provide the one
// global the pure checks read (node --test isolates globals per test file).
globalThis.window = { location: { href: "https://demo.example/app?utm=x#top" } };

const { state } = require("../widget/src/state.js");
const { FEEDBACK_STORAGE_VERSION, serializeFeedbackForStorage, normalizePersistedFeedback, isMatchingFeedbackEnvelope } = require("../widget/src/persistence.js");

state.options.projectId = "proj-a";
state.options.demoId = "demo-1";

function envelope(overrides = {}) {
  return {
    version: FEEDBACK_STORAGE_VERSION,
    projectId: "proj-a",
    demoId: "demo-1",
    pageUrl: "https://demo.example/app",
    feedback: [],
    ...overrides
  };
}

test("serializeFeedbackForStorage deep-copies the item and round-trips through normalize", () => {
  const item = {
    id: "pl_1",
    target: { kind: "point", x: 12.3, selector: "main > p" },
    screenshot: { status: "captured", dataUrl: "data:image/svg+xml;base64,abc" }
  };
  const copy = serializeFeedbackForStorage(item);
  assert.notEqual(copy, item);
  assert.deepEqual(copy, item);
  assert.equal(normalizePersistedFeedback(copy), copy);
});

test("serializeFeedbackForStorage omits the screenshot dataUrl on request without touching the item", () => {
  const item = { id: "pl_2", target: {}, screenshot: { status: "captured", dataUrl: "data:image/svg+xml;base64,abc" } };
  const copy = serializeFeedbackForStorage(item, { omitScreenshotDataUrl: true });
  assert.equal(copy.screenshot.dataUrl, undefined);
  assert.equal(copy.screenshot.persistedWithoutDataUrl, true);
  assert.equal(item.screenshot.dataUrl, "data:image/svg+xml;base64,abc");
});

test("serializeFeedbackForStorage returns null for unserializable items", () => {
  const item = { id: "pl_3", target: {} };
  item.self = item;
  assert.equal(serializeFeedbackForStorage(item), null);
});

test("normalizePersistedFeedback keeps items with an id and an object target", () => {
  const item = { id: "pl_4", target: { kind: "area" } };
  assert.equal(normalizePersistedFeedback(item), item);
});

test("normalizePersistedFeedback rejects malformed entries", () => {
  assert.equal(normalizePersistedFeedback(null), null);
  assert.equal(normalizePersistedFeedback("text"), null);
  assert.equal(normalizePersistedFeedback({ target: {} }), null);
  assert.equal(normalizePersistedFeedback({ id: "x" }), null);
  assert.equal(normalizePersistedFeedback({ id: "x", target: "main > p" }), null);
});

test("isMatchingFeedbackEnvelope matches the current version/project/demo/page", () => {
  assert.equal(isMatchingFeedbackEnvelope(envelope()), true);
  // Query string and hash differences on the same page still match.
  assert.equal(isMatchingFeedbackEnvelope(envelope({ pageUrl: "https://demo.example/app?other=1#sec" })), true);
});

test("isMatchingFeedbackEnvelope rejects mismatched envelopes", () => {
  assert.equal(isMatchingFeedbackEnvelope(null), false);
  assert.equal(isMatchingFeedbackEnvelope([]), false);
  assert.equal(isMatchingFeedbackEnvelope(envelope({ version: FEEDBACK_STORAGE_VERSION + 1 })), false);
  assert.equal(isMatchingFeedbackEnvelope(envelope({ projectId: "someone-else" })), false);
  assert.equal(isMatchingFeedbackEnvelope(envelope({ demoId: "other-demo" })), false);
  assert.equal(isMatchingFeedbackEnvelope(envelope({ pageUrl: "https://demo.example/other" })), false);
  assert.equal(isMatchingFeedbackEnvelope(envelope({ feedback: {} })), false);
});
