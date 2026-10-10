"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeUncaptured, summarizeUncaptured } = require("../server/uncaptured.js");

function detected(overrides = {}) {
  return {
    version: 1,
    status: "detected",
    scannedElements: 79,
    scanTruncated: false,
    counts: { "shadow-host": 1, canvas: 1, frame: 0, embed: 0, video: 0 },
    regions: [
      { kind: "shadow-host", tag: "nextjs-portal", relation: "covers-target", rects: [{ x: 20, y: 869, width: 40, height: 40 }] },
      { kind: "canvas", tag: "canvas", relation: "none", rects: [{ x: 487, y: 83, width: 120, height: 50 }] }
    ],
    ...overrides
  };
}

const INVALID = { version: 1, status: "invalid" };

test("a well-formed record is kept, with only the fields of version 1", () => {
  assert.deepEqual(normalizeUncaptured(detected()), detected());
  const noisy = detected({ extra: "dropped" });
  noisy.counts = { ...noisy.counts };
  noisy.regions = noisy.regions.map((region) => ({ ...region, extra: true, rects: region.rects.map((rect) => ({ ...rect, extra: 1 })) }));
  assert.deepEqual(normalizeUncaptured(noisy), detected());
  assert.deepEqual(normalizeUncaptured(detected({ regions: [] })), detected({ regions: [] }));
});

test("a tag of any length is kept: the widget sends the element's name as the page has it", () => {
  const longName = `x-${"a".repeat(200)}`;
  const record = detected({ regions: [{ kind: "shadow-host", tag: longName, relation: "none", rects: [{ x: 0, y: 0, width: 10, height: 10 }] }] });
  assert.equal(normalizeUncaptured(record).regions[0].tag, longName);
});

test("a failed detection is kept, with its error message when it is a string", () => {
  assert.deepEqual(normalizeUncaptured({ version: 1, status: "failed" }), { version: 1, status: "failed" });
  assert.deepEqual(normalizeUncaptured({ version: 1, status: "failed", error: "hit test failed", extra: 1 }), { version: 1, status: "failed", error: "hit test failed" });
  assert.deepEqual(normalizeUncaptured({ version: 1, status: "failed", error: { message: "x" } }), INVALID);
});

test("a malformed version 1 record becomes invalid", () => {
  const region = detected().regions[0];
  for (const broken of [
    detected({ status: "unknown" }),
    detected({ scannedElements: -1 }),
    detected({ scannedElements: 1.5 }),
    detected({ scanTruncated: "no" }),
    detected({ counts: { canvas: 1 } }),
    detected({ counts: { ...detected().counts, img: 2 } }),
    detected({ counts: { ...detected().counts, video: -1 } }),
    detected({ counts: [] }),
    detected({ regions: "none" }),
    detected({ regions: Array.from({ length: 21 }, () => region) }),
    detected({ regions: [null] }),
    detected({ regions: [{ ...region, kind: "img" }] }),
    detected({ regions: [{ ...region, relation: "near" }] }),
    detected({ regions: [{ ...region, tag: "" }] }),
    detected({ regions: [{ ...region, tag: 7 }] }),
    detected({ regions: [{ ...region, rects: [] }] }),
    detected({ regions: [{ ...region, rects: Array.from({ length: 5 }, () => region.rects[0]) }] }),
    detected({ regions: [{ ...region, rects: [{ x: 0, y: 0, width: 0, height: 10 }] }] }),
    detected({ regions: [{ ...region, rects: [{ x: "0", y: 0, width: 10, height: 10 }] }] }),
    detected({ regions: [{ ...region, rects: [{ x: 0, y: null, width: 10, height: 10 }] }] })
  ]) {
    assert.deepEqual(normalizeUncaptured(broken), INVALID, JSON.stringify(broken).slice(0, 120));
  }
});

test("a record without an integer version becomes invalid with a null version", () => {
  for (const value of [null, "detected", [], {}, { version: "1", status: "detected" }, { version: 1.5 }]) {
    assert.deepEqual(normalizeUncaptured(value), { version: null, status: "invalid" }, JSON.stringify(value));
  }
});

test("a later version is kept as sent, for readers that know it", () => {
  const later = { version: 2, status: "detected", somethingNew: [1, 2, 3] };
  assert.equal(normalizeUncaptured(later), later);
});

test("the summary lists the elements touching the spot with their numbers and counts the rest", () => {
  const record = detected({
    counts: { "shadow-host": 1, canvas: 2, frame: 0, embed: 0, video: 0 },
    regions: [
      { kind: "shadow-host", tag: "nextjs-portal", relation: "covers-target", rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
      { kind: "canvas", tag: "canvas", relation: "overlaps-target", rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
      { kind: "canvas", tag: "canvas", relation: "none", rects: [{ x: 0, y: 0, width: 10, height: 10 }] }
    ],
    scanTruncated: true
  });
  assert.deepEqual(summarizeUncaptured({ status: "saved", uncaptured: record }), {
    state: "detected",
    touching: [
      { number: 1, kindName: "shadow DOM", tag: "nextjs-portal", relation: "covers-target" },
      { number: 2, kindName: "canvas", tag: "canvas", relation: "overlaps-target" }
    ],
    elsewhere: 1,
    scanTruncated: true
  });
  assert.deepEqual(summarizeUncaptured({ uncaptured: detected({ counts: { "shadow-host": 0, canvas: 0, frame: 0, embed: 0, video: 0 }, regions: [] }) }), {
    state: "detected", touching: [], elsewhere: 0, scanTruncated: false
  });
});

test("the summary tells not checked, failed, invalid and unknown versions apart", () => {
  assert.deepEqual(summarizeUncaptured({ status: "saved" }), { state: "not-checked" });
  assert.deepEqual(summarizeUncaptured(null), { state: "not-checked" });
  assert.deepEqual(summarizeUncaptured({ uncaptured: { version: 1, status: "failed", error: "x" } }), { state: "failed" });
  assert.deepEqual(summarizeUncaptured({ uncaptured: { version: 1, status: "invalid" } }), { state: "invalid" });
  assert.deepEqual(summarizeUncaptured({ uncaptured: { version: null, status: "invalid" } }), { state: "invalid" });
  // A record stored before the receiver checked it is read the same way.
  assert.deepEqual(summarizeUncaptured({ uncaptured: detected({ scanTruncated: "no" }) }), { state: "invalid" });
  assert.deepEqual(summarizeUncaptured({ uncaptured: { version: 3, anything: true } }), { state: "unknown-version", version: 3 });
});
