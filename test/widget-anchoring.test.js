"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  pointAnchorOffsets,
  areaAnchorOffsets,
  roundedAnchor,
  geometryFromAnchor,
  viewportDiffersFromCreation
} = require("../widget/src/anchoring.js");

const ELEMENT_RECT = { left: 100, top: 200, width: 400, height: 100 };

test("pointAnchorOffsets expresses the point as percentages of the element rect", () => {
  assert.deepEqual(pointAnchorOffsets(ELEMENT_RECT, { clientX: 300, clientY: 225 }), { x: 50, y: 25 });
  assert.deepEqual(pointAnchorOffsets(ELEMENT_RECT, { clientX: 100, clientY: 200 }), { x: 0, y: 0 });
});

test("areaAnchorOffsets expresses the rect as percentages of the element rect", () => {
  const offsets = areaAnchorOffsets(ELEMENT_RECT, { leftPx: 200, topPx: 225, widthPx: 100, heightPx: 50 });
  assert.deepEqual(offsets, { x: 25, y: 25, width: 25, height: 50 });
});

test("roundedAnchor rounds offsets and keeps the selector", () => {
  assert.equal(roundedAnchor(null), null);
  assert.deepEqual(roundedAnchor({ x: 12.34, y: 56.78 }), { x: 12.3, y: 56.8 });
  assert.deepEqual(
    roundedAnchor({ x: 1.11, y: 2.22, width: 3.33, height: 4.44, selector: "#hero" }),
    { x: 1.1, y: 2.2, width: 3.3, height: 4.4, selector: "#hero" }
  );
});

test("geometryFromAnchor resolves a point anchor against the current rect and scroll", () => {
  const geometry = geometryFromAnchor("point", { x: 50, y: 25 }, ELEMENT_RECT, 10, 20);
  assert.deepEqual(geometry, { kind: "point", pageX: 10 + 100 + 200, pageY: 20 + 200 + 25 });
});

test("geometryFromAnchor resolves an area anchor and enforces minimum size", () => {
  const geometry = geometryFromAnchor("area", { x: 25, y: 25, width: 25, height: 50 }, ELEMENT_RECT, 0, 0);
  assert.deepEqual(geometry, { kind: "area", pageLeftPx: 200, pageTopPx: 225, widthPx: 100, heightPx: 50 });

  const tiny = geometryFromAnchor("area", { x: 0, y: 0, width: 0.1, height: 0.1 }, ELEMENT_RECT, 0, 0);
  assert.equal(tiny.widthPx, 1);
  assert.equal(tiny.heightPx, 1);
});

test("geometryFromAnchor rejects anchors with missing or invalid offsets", () => {
  assert.equal(geometryFromAnchor("point", null, ELEMENT_RECT, 0, 0), null);
  assert.equal(geometryFromAnchor("point", { x: NaN, y: 10 }, ELEMENT_RECT, 0, 0), null);
  assert.equal(geometryFromAnchor("point", { x: 10 }, ELEMENT_RECT, 0, 0), null);
  // area anchors additionally require width/height
  assert.equal(geometryFromAnchor("area", { x: 10, y: 10 }, ELEMENT_RECT, 0, 0), null);
  assert.equal(geometryFromAnchor("area", { x: 10, y: 10, width: 5, height: "abc" }, ELEMENT_RECT, 0, 0), null);
});

test("viewportDiffersFromCreation tolerates a one-pixel difference", () => {
  const metrics = { windowWidth: 1024, windowHeight: 768 };
  const item = (width, height) => ({ environment: { viewport: { width, height } } });
  assert.equal(viewportDiffersFromCreation(item(1024, 768), metrics), false);
  assert.equal(viewportDiffersFromCreation(item(1025, 769), metrics), false);
  assert.equal(viewportDiffersFromCreation(item(1026, 768), metrics), true);
  assert.equal(viewportDiffersFromCreation(item(1024, 766), metrics), true);
  assert.equal(viewportDiffersFromCreation({}, metrics), true);
  assert.equal(viewportDiffersFromCreation(null, metrics), true);
});
