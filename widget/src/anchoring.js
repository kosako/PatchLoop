// Pure re-anchoring math (issue #41): markers are anchored to their target
// element via selector + position inside the element rect (percent), so they
// can follow layout reflows. Element resolution stays in index.js; everything
// here works on plain rects and numbers.

import { round, numberOrNull } from "./geometry.js";

export function pointAnchorOffsets(elementRect, point) {
  return {
    x: ((point.clientX - elementRect.left) / elementRect.width) * 100,
    y: ((point.clientY - elementRect.top) / elementRect.height) * 100
  };
}

export function areaAnchorOffsets(elementRect, rect) {
  return {
    x: ((rect.leftPx - elementRect.left) / elementRect.width) * 100,
    y: ((rect.topPx - elementRect.top) / elementRect.height) * 100,
    width: (rect.widthPx / elementRect.width) * 100,
    height: (rect.heightPx / elementRect.height) * 100
  };
}

export function roundedAnchor(anchor) {
  if (!anchor) return null;
  const rounded = { x: round(anchor.x), y: round(anchor.y) };
  if (anchor.width != null) rounded.width = round(anchor.width);
  if (anchor.height != null) rounded.height = round(anchor.height);
  if (anchor.selector) rounded.selector = anchor.selector;
  return rounded;
}

// Resolves an anchor back to page-pixel geometry against the element's
// current rect. Returns null when the anchor lacks the required offsets.
export function geometryFromAnchor(kind, anchor, elementRect, scrollX, scrollY) {
  if (!anchor || numberOrNull(anchor.x) == null || numberOrNull(anchor.y) == null) return null;

  if (kind === "area") {
    if (numberOrNull(anchor.width) == null || numberOrNull(anchor.height) == null) return null;
    return {
      kind: "area",
      pageLeftPx: scrollX + elementRect.left + (anchor.x / 100) * elementRect.width,
      pageTopPx: scrollY + elementRect.top + (anchor.y / 100) * elementRect.height,
      widthPx: Math.max(1, (anchor.width / 100) * elementRect.width),
      heightPx: Math.max(1, (anchor.height / 100) * elementRect.height)
    };
  }

  return {
    kind: "point",
    pageX: scrollX + elementRect.left + (anchor.x / 100) * elementRect.width,
    pageY: scrollY + elementRect.top + (anchor.y / 100) * elementRect.height
  };
}

export function viewportDiffersFromCreation(item, metrics) {
  const viewport = item?.environment?.viewport;
  if (!viewport) return true;
  return Math.abs(viewport.width - metrics.windowWidth) > 1
    || Math.abs(viewport.height - metrics.windowHeight) > 1;
}
