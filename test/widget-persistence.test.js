"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// isMatchingFeedbackEnvelope compares the stored pageUrl against
// window.location.href at call time; node has no window, so provide the one
// global the pure checks read (node --test isolates globals per test file).
globalThis.window = { location: { href: "https://demo.example/app?utm=x#top" } };

const { state } = require("../widget/src/state.js");
const { FEEDBACK_STORAGE_VERSION, serializeFeedbackForStorage, normalizePersistedFeedback, isMatchingFeedbackEnvelope, loadPersistedFeedback, persistFeedbackList, clearPersistedFeedback } = require("../widget/src/persistence.js");

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

function persistenceSession(t) {
  const previousOptions = state.options;
  const previousFeedback = state.feedback;
  const previousWindow = globalThis.window;
  const entries = new Map();
  state.options = { ...state.options, persistFeedback: true, feedbackStorageKey: "patchloop:feedback" };
  globalThis.window = {
    location: { href: "https://demo.example/app" },
    localStorage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key)
    }
  };
  t.after(() => {
    state.options = previousOptions;
    state.feedback = previousFeedback;
    globalThis.window = previousWindow;
  });
  return entries;
}

function saveDraft(id) {
  state.feedback = [{ id, target: { kind: "point" }, comment: `Draft ${id}` }];
  persistFeedbackList();
}

test("feedback survives writing and clearing another page, project, or demo", (t) => {
  persistenceSession(t);
  const contexts = [
    { projectId: "proj-a", demoId: "demo-1", url: "https://demo.example/app" },
    { projectId: "proj-a", demoId: "demo-1", url: "https://demo.example/other" },
    { projectId: "proj-b", demoId: "demo-1", url: "https://demo.example/app" },
    { projectId: "proj-a", demoId: "demo-2", url: "https://demo.example/app" }
  ];
  const enter = (context) => {
    Object.assign(state.options, { projectId: context.projectId, demoId: context.demoId });
    globalThis.window.location.href = context.url;
  };
  contexts.forEach((context, index) => {
    enter(context);
    assert.deepEqual(loadPersistedFeedback(), []);
    saveDraft(`draft-${index}`);
  });
  contexts.forEach((context, index) => {
    enter(context);
    assert.equal(loadPersistedFeedback()[0].id, `draft-${index}`);
  });
  enter(contexts[1]);
  clearPersistedFeedback();
  assert.deepEqual(loadPersistedFeedback(), []);
  contexts.filter((_, index) => index !== 1).forEach((context) => {
    enter(context);
    assert.equal(loadPersistedFeedback().length, 1);
  });
});

test("query and hash navigation shares a page's saved feedback", (t) => {
  const entries = persistenceSession(t);
  saveDraft("original");
  globalThis.window.location.href = "https://demo.example/app?utm=test#section";
  assert.equal(loadPersistedFeedback()[0].id, "original");
  saveDraft("updated");
  assert.equal(entries.size, 1);
  globalThis.window.location.href = "https://demo.example/app";
  assert.equal(loadPersistedFeedback()[0].id, "updated");
});

test("custom storage namespaces remain separate, including clear", (t) => {
  persistenceSession(t);
  state.options.feedbackStorageKey = "custom-a";
  saveDraft("a");
  state.options.feedbackStorageKey = "custom-b";
  assert.deepEqual(loadPersistedFeedback(), []);
  saveDraft("b");
  clearPersistedFeedback();
  state.options.feedbackStorageKey = "custom-a";
  assert.equal(loadPersistedFeedback()[0].id, "a");
});

test("matching legacy feedback migrates after the scoped copy succeeds", (t) => {
  const entries = persistenceSession(t);
  state.options.feedbackStorageKey = "custom-legacy";
  const raw = JSON.stringify(envelope({ feedback: [{ id: "legacy", target: {} }] }));
  entries.set("custom-legacy", raw);
  assert.equal(loadPersistedFeedback()[0].id, "legacy");
  assert.equal(entries.has("custom-legacy"), false);
  assert.equal(entries.size, 1);
  assert.equal([...entries.values()][0], raw);
  assert.equal(loadPersistedFeedback()[0].id, "legacy");
});

test("another scope's legacy envelope is neither migrated nor cleared", (t) => {
  const entries = persistenceSession(t);
  const raw = JSON.stringify(envelope({ feedback: [{ id: "legacy", target: {} }] }));
  entries.set(state.options.feedbackStorageKey, raw);
  globalThis.window.location.href = "https://demo.example/other";
  assert.deepEqual(loadPersistedFeedback(), []);
  clearPersistedFeedback();
  assert.equal(entries.get(state.options.feedbackStorageKey), raw);
  saveDraft("other");
  assert.equal(entries.get(state.options.feedbackStorageKey), raw);
  globalThis.window.location.href = "https://demo.example/app";
  assert.equal(loadPersistedFeedback()[0].id, "legacy");
});

test("failed migration and failed persistence retain the legacy copy", (t) => {
  const entries = persistenceSession(t);
  const raw = JSON.stringify(envelope({ feedback: [{ id: "legacy", target: {} }] }));
  entries.set(state.options.feedbackStorageKey, raw);
  const warnings = t.mock.method(console, "warn", () => {});
  globalThis.window.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  state.feedback = loadPersistedFeedback();
  assert.equal(state.feedback[0].id, "legacy");
  persistFeedbackList();
  assert.equal(entries.size, 1);
  assert.equal(entries.get(state.options.feedbackStorageKey), raw);
  assert.equal(warnings.mock.callCount(), 2);
  clearPersistedFeedback();
  assert.equal(entries.size, 0);
});

test("scoped feedback takes precedence over an old legacy copy", (t) => {
  const entries = persistenceSession(t);
  saveDraft("current");
  entries.set(state.options.feedbackStorageKey, JSON.stringify(envelope({ feedback: [{ id: "old", target: {} }] })));
  assert.equal(loadPersistedFeedback()[0].id, "current");
  clearPersistedFeedback();
  assert.deepEqual(loadPersistedFeedback(), []);
  assert.equal(entries.size, 0);
});

test("quota fallback compacts only the current scope's screenshot", (t) => {
  const entries = persistenceSession(t);
  const warnings = t.mock.method(console, "warn", () => {});
  saveDraft("other-page");
  globalThis.window.location.href = "https://demo.example/other";
  state.feedback = [{ id: "screenshot", target: {}, screenshot: { status: "captured", dataUrl: "data:image/svg+xml;base64,abc" } }];
  globalThis.window.localStorage.setItem = (key, value) => {
    if (JSON.parse(value).feedback.some((item) => item.screenshot?.dataUrl)) throw new Error("QuotaExceededError");
    entries.set(key, value);
  };
  persistFeedbackList();
  const restored = loadPersistedFeedback()[0];
  assert.equal(restored.screenshot.dataUrl, undefined);
  assert.equal(restored.screenshot.persistedWithoutDataUrl, true);
  assert.ok(state.feedback[0].screenshot.dataUrl);
  assert.equal(warnings.mock.callCount(), 1);
  globalThis.window.location.href = "https://demo.example/app";
  assert.equal(loadPersistedFeedback()[0].id, "other-page");
});
