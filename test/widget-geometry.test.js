"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  round,
  numberOrNull,
  pointFromClient,
  rectFromPoints,
  rectContainsArea,
  documentPercentToPxX,
  documentPercentToPxY,
  pointFromStoredTarget,
  rectFromStoredArea
} = require("../widget/src/geometry.js");

const METRICS = {
  scrollX: 100,
  scrollY: 200,
  viewportWidth: 1000,
  viewportHeight: 500,
  documentWidth: 2000,
  documentHeight: 4000,
  windowWidth: 1024,
  windowHeight: 768
};

test("round keeps one decimal", () => {
  assert.equal(round(12.34), 12.3);
  assert.equal(round(12.35), 12.4);
  assert.equal(round(-1.25), -1.2);
});

test("numberOrNull accepts finite numbers only", () => {
  assert.equal(numberOrNull(5), 5);
  assert.equal(numberOrNull("5.5"), 5.5);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull(NaN), null);
  assert.equal(numberOrNull(Infinity), null);
  assert.equal(numberOrNull("abc"), null);
  assert.equal(numberOrNull(undefined), null);
});

test("pointFromClient derives page pixels and percentages", () => {
  const point = pointFromClient(250, 100, METRICS);
  assert.equal(point.clientX, 250);
  assert.equal(point.clientY, 100);
  assert.equal(point.pageX, 350);
  assert.equal(point.pageY, 300);
  assert.equal(point.x, 25);
  assert.equal(point.y, 20);
  assert.equal(point.documentX, 17.5);
  assert.equal(point.documentY, 7.5);
});

test("pointFromClient clamps zero-sized dimensions to 1", () => {
  const point = pointFromClient(10, 10, { ...METRICS, viewportWidth: 0, documentHeight: 0 });
  assert.equal(point.x, 1000);
  assert.equal(point.documentY, (10 + METRICS.scrollY) * 100);
});

test("rectFromPoints normalizes a drag in any direction", () => {
  const down = rectFromPoints({ clientX: 100, clientY: 50 }, { clientX: 300, clientY: 150 }, METRICS);
  const up = rectFromPoints({ clientX: 300, clientY: 150 }, { clientX: 100, clientY: 50 }, METRICS);
  assert.deepEqual(down, up);
  assert.equal(down.leftPx, 100);
  assert.equal(down.topPx, 50);
  assert.equal(down.widthPx, 200);
  assert.equal(down.heightPx, 100);
  assert.equal(down.pageLeftPx, 200);
  assert.equal(down.pageTopPx, 250);
  assert.equal(down.x, 10);
  assert.equal(down.width, 20);
  assert.equal(down.documentX, 10);
  assert.equal(down.documentWidth, 10);
});

test("rectContainsArea tolerates one pixel on each edge", () => {
  const rect = { leftPx: 10, topPx: 10, rightPx: 90, bottomPx: 90 };
  assert.ok(rectContainsArea({ left: 10, top: 10, right: 90, bottom: 90 }, rect));
  assert.ok(rectContainsArea({ left: 11, top: 11, right: 89, bottom: 89 }, rect));
  assert.ok(!rectContainsArea({ left: 12, top: 10, right: 90, bottom: 90 }, rect));
  assert.ok(!rectContainsArea({ left: 10, top: 10, right: 88, bottom: 90 }, rect));
});

test("documentPercentToPx resolves against document size with window floor", () => {
  assert.equal(documentPercentToPxX(50, METRICS), 1000);
  assert.equal(documentPercentToPxY(25, METRICS), 1000);
  // window size wins when the document reports smaller
  assert.equal(documentPercentToPxX(50, { ...METRICS, documentWidth: 10 }), 512);
  assert.equal(documentPercentToPxX("abc", METRICS), null);
  assert.equal(documentPercentToPxX(undefined, METRICS), null);
});

test("pointFromStoredTarget prefers stored pixels over percentages", () => {
  assert.deepEqual(pointFromStoredTarget({ pageX: 300, pageY: 400, documentX: 50, documentY: 50 }, METRICS), { pageX: 300, pageY: 400 });
  // falls back to document percentages when pixels are missing
  assert.deepEqual(pointFromStoredTarget({ documentX: 50, documentY: 25 }, METRICS), { pageX: 1000, pageY: 1000 });
  assert.equal(pointFromStoredTarget({ pageX: 300 }, METRICS), null);
  assert.equal(pointFromStoredTarget({}, METRICS), null);
});

test("rectFromStoredArea restores pixels, falls back, and enforces minimum size", () => {
  const stored = rectFromStoredArea({ pageX: 10, pageY: 20, clientWidth: 30, clientHeight: 40 }, METRICS);
  assert.deepEqual(stored, { pageLeftPx: 10, pageTopPx: 20, widthPx: 30, heightPx: 40 });

  const fallback = rectFromStoredArea({ documentX: 50, documentY: 25, documentWidth: 10, documentHeight: 10 }, METRICS);
  assert.deepEqual(fallback, { pageLeftPx: 1000, pageTopPx: 1000, widthPx: 200, heightPx: 400 });

  const tiny = rectFromStoredArea({ pageX: 0, pageY: 0, clientWidth: 0, clientHeight: 0.5 }, METRICS);
  assert.equal(tiny.widthPx, 1);
  assert.equal(tiny.heightPx, 1);

  assert.equal(rectFromStoredArea({ pageX: 10, pageY: 20 }, METRICS), null);
});
