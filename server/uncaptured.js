"use strict";

// screenshot.uncaptured (#148): what the widget found on the page that its
// screenshot cannot show. The receiver keeps a feedback whose record is
// malformed, but replaces the record with { version, status: "invalid" } so
// everything that reads it later can rely on its shape. A later version than
// this receiver knows is kept as sent, for readers that do know it.

const UNCAPTURED_VERSION = 1;
const UNCAPTURED_KINDS = ["shadow-host", "canvas", "frame", "embed", "video"];
const UNCAPTURED_RELATIONS = ["covers-target", "overlaps-target", "none"];
// The widget sends at most 20 regions of at most 4 rects each.
const MAX_REGIONS = 20;
const MAX_RECTS = 4;
const MAX_TAG_LENGTH = 100;

function normalizeUncaptured(value) {
  if (!isPlainObject(value) || !Number.isInteger(value.version)) return { version: null, status: "invalid" };
  if (value.version !== UNCAPTURED_VERSION) return value;
  return cleanVersion1(value) || { version: value.version, status: "invalid" };
}

// A copy holding only the fields of version 1, or null when any is malformed.
function cleanVersion1(value) {
  if (value.status === "failed") {
    if (value.error != null && typeof value.error !== "string") return null;
    return value.error == null
      ? { version: UNCAPTURED_VERSION, status: "failed" }
      : { version: UNCAPTURED_VERSION, status: "failed", error: value.error };
  }
  if (value.status !== "detected") return null;
  if (!isCount(value.scannedElements) || typeof value.scanTruncated !== "boolean") return null;
  if (!isPlainObject(value.counts) || Object.keys(value.counts).some((kind) => !UNCAPTURED_KINDS.includes(kind))) return null;
  if (!UNCAPTURED_KINDS.every((kind) => isCount(value.counts[kind]))) return null;
  if (!Array.isArray(value.regions) || value.regions.length > MAX_REGIONS) return null;
  const regions = value.regions.map(cleanRegion);
  if (regions.includes(null)) return null;
  return {
    version: UNCAPTURED_VERSION,
    status: "detected",
    scannedElements: value.scannedElements,
    scanTruncated: value.scanTruncated,
    counts: Object.fromEntries(UNCAPTURED_KINDS.map((kind) => [kind, value.counts[kind]])),
    regions
  };
}

function cleanRegion(region) {
  if (!isPlainObject(region)) return null;
  if (!UNCAPTURED_KINDS.includes(region.kind) || !UNCAPTURED_RELATIONS.includes(region.relation)) return null;
  if (typeof region.tag !== "string" || region.tag.length === 0 || region.tag.length > MAX_TAG_LENGTH) return null;
  if (!Array.isArray(region.rects) || region.rects.length === 0 || region.rects.length > MAX_RECTS) return null;
  const rects = region.rects.map(cleanRect);
  if (rects.includes(null)) return null;
  return { kind: region.kind, tag: region.tag, relation: region.relation, rects };
}

function cleanRect(rect) {
  if (!isPlainObject(rect)) return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = { normalizeUncaptured };
