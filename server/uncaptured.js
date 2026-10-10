"use strict";

// screenshot.uncaptured (#148): what the widget found on the page that its
// screenshot cannot show. The receiver keeps a feedback whose record is
// malformed, but replaces the record with { version, status: "invalid" } so
// everything that reads it later can rely on its shape. A later version than
// this receiver knows is kept as sent, for readers that do know it.

const UNCAPTURED_VERSION = 1;
const UNCAPTURED_KINDS = ["shadow-host", "canvas", "frame", "embed", "video"];
const UNCAPTURED_RELATIONS = ["covers-target", "overlaps-target", "none"];
// How a kind reads next to an element's name, in the inbox, Issues and Slack.
const KIND_NAMES = { "shadow-host": "shadow DOM", canvas: "canvas", frame: "iframe", embed: "embed / object", video: "video" };
// The widget sends at most 20 regions of at most 4 rects each. A tag is the
// element's name as the page has it; its length is left to the receiver's
// field length limit.
const MAX_REGIONS = 20;
const MAX_RECTS = 4;

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
  if (typeof region.tag !== "string" || region.tag.length === 0) return null;
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

// What a reader of a stored feedback should learn from screenshot.uncaptured,
// for the inbox, GitHub Issues and Slack to word in their own language. state is
// "not-checked" (no record: the widget predates the check), "detected",
// "failed", "invalid" or "unknown-version". A detected record lists the
// elements that touch the selected spot with their numbers on the image (their
// place in regions) and counts the rest. The record is read through
// normalizeUncaptured, so records stored before the receiver checked them read
// the same way.
function summarizeUncaptured(screenshot) {
  if (!screenshot || !Object.hasOwn(screenshot, "uncaptured")) return { state: "not-checked" };
  const record = normalizeUncaptured(screenshot.uncaptured);
  if (record.version === null) return { state: "invalid" };
  if (record.version !== UNCAPTURED_VERSION) return { state: "unknown-version", version: record.version };
  if (record.status !== "detected") return { state: record.status };
  const touching = record.regions
    .map((region, index) => ({ number: index + 1, kindName: KIND_NAMES[region.kind], tag: region.tag, relation: region.relation }))
    .filter((region) => region.relation !== "none");
  const total = UNCAPTURED_KINDS.reduce((sum, kind) => sum + record.counts[kind], 0);
  return { state: "detected", touching, elsewhere: Math.max(0, total - touching.length), scanTruncated: record.scanTruncated };
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = { normalizeUncaptured, summarizeUncaptured };
