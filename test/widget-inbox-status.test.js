"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  statusLookupUrl, statusLookupIds, statusesFromAnswer, isFinished,
  initialLookupState, lookupOutcome, lookupAfter, LOOKUP_MIN_GAP_MS, LOOKUP_MAX_GAP_MS
} = require("../widget/src/inbox-status.js");

const PAGE = "https://demo.example/app/page";

test("the lookup URL sits next to an endpoint ending in /feedback, and nowhere else", () => {
  assert.equal(statusLookupUrl("http://127.0.0.1:4010/feedback", PAGE), "http://127.0.0.1:4010/feedback-status");
  assert.equal(statusLookupUrl("/patchloop/feedback?key=1#top", PAGE), "https://demo.example/patchloop/feedback-status");
  assert.equal(statusLookupUrl("feedback", PAGE), "https://demo.example/app/feedback-status");
  assert.equal(statusLookupUrl("http://127.0.0.1:4010/feedback/", PAGE), null);
  assert.equal(statusLookupUrl("https://hooks.example/inbox", PAGE), null);
  assert.equal(statusLookupUrl("", PAGE), null);
  // No endpoint means no receiver, even on a page whose own path ends in /feedback.
  assert.equal(statusLookupUrl("", "https://demo.example/feedback"), null);
  assert.equal(statusLookupUrl("  ", "https://demo.example/feedback"), null);
  assert.equal(statusLookupUrl("http://", PAGE), null);
});

test("only comments the receiver holds are asked about, newest first, at most 200", () => {
  const feedback = [
    { id: "ok", delivery: { ok: true, status: 201 } },
    { id: "duplicate", delivery: { ok: false, status: 409 } },
    { id: "failed", delivery: { ok: false, status: 500 } },
    { id: "offline", delivery: { ok: false, error: "Failed to fetch" } },
    { id: "pending", delivery: { pending: true, target: "receiver" } },
    { id: "interrupted", delivery: { ok: null, interrupted: true, target: "receiver" } },
    { id: "slack", delivery: { ok: null, status: "unknown", target: "slack-webhook" } },
    { id: "local" }
  ];
  assert.deepEqual(statusLookupIds(feedback), ["ok", "duplicate"]);
  const many = Array.from({ length: 205 }, (_, i) => ({ id: `pl_${i}`, delivery: { ok: true, status: 201 } }));
  const ids = statusLookupIds(many);
  assert.equal(ids.length, 200);
  assert.equal(ids[0], "pl_0");
  assert.equal(ids[199], "pl_199");
});

test("an answer gives id -> status pairs, dropping unknown statuses and odd entries", () => {
  const statuses = statusesFromAnswer({
    ok: true,
    statuses: [
      { id: "a", status: "fixed" },
      { id: "b", status: "new" },
      { id: "c", status: "deleted" },
      { id: 7, status: "fixed" },
      null
    ]
  });
  assert.deepEqual([...statuses], [["a", "fixed"], ["b", "new"]]);
  assert.equal(statusesFromAnswer({ ok: false, error: "Not Found" }), null);
  assert.equal(statusesFromAnswer({ ok: true, statuses: {} }), null);
  assert.equal(statusesFromAnswer(null), null);
});

test("fixed and ignored are finished, unless the comment was edited here since", () => {
  const statuses = new Map([["fixed", "fixed"], ["ignored", "ignored"], ["accepted", "accepted"], ["new", "new"]]);
  assert.equal(isFinished({ id: "fixed" }, statuses), true);
  assert.equal(isFinished({ id: "ignored" }, statuses), true);
  assert.equal(isFinished({ id: "accepted" }, statuses), false);
  assert.equal(isFinished({ id: "new" }, statuses), false);
  assert.equal(isFinished({ id: "unknown" }, statuses), false);
  assert.equal(isFinished({ id: "fixed", localEdited: true }, statuses), false);
  assert.equal(isFinished({ id: "fixed" }, null), false);
});

test("401, 403 and 404 stop the lookup; anything but a good answer backs off", () => {
  const statuses = new Map();
  assert.equal(lookupOutcome(200, statuses), "ok");
  assert.equal(lookupOutcome(200, null), "failed");
  for (const status of [401, 403, 404]) assert.equal(lookupOutcome(status, null), "unavailable");
  for (const status of [0, 400, 429, 500, 503]) assert.equal(lookupOutcome(status, null), "failed");

  const start = initialLookupState();
  assert.deepEqual(start, { stopped: false, failures: 0, nextAt: 0 });
  assert.equal(lookupAfter(start, "unavailable", 1000).stopped, true);
  assert.deepEqual(lookupAfter(start, "ok", 1000), { stopped: false, failures: 0, nextAt: 1000 + LOOKUP_MIN_GAP_MS });

  let lookup = start;
  const gaps = [];
  for (let i = 0; i < 6; i += 1) {
    lookup = lookupAfter(lookup, "failed", 0);
    gaps.push(lookup.nextAt);
  }
  assert.deepEqual(gaps, [60_000, 120_000, 240_000, 480_000, LOOKUP_MAX_GAP_MS, LOOKUP_MAX_GAP_MS]);
  assert.deepEqual(lookupAfter(lookup, "ok", 0), { stopped: false, failures: 0, nextAt: LOOKUP_MIN_GAP_MS });
});
