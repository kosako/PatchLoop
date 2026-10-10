// Detects page elements the SVG snapshot cannot draw (#148): open shadow
// roots, canvas, iframe / frame, embed / object and video. The snapshot clones
// the body and draws it as an image, so these come out blank or missing. The
// payload records their kind, position and relation to the selected spot, so
// whoever reads the feedback can tell that the cause may be missing from the
// image. Contents (shadow trees, frame documents) are never read or sent.
//
// The DOM is passed in (the root element and the hit test), so node:test can
// exercise the scan with plain objects.

export const UNCAPTURED_VERSION = 1;
// The widget's own nodes, which the snapshot leaves out as well.
export const WIDGET_NODES = "[data-patchloop-root], [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection]";
export const UNCAPTURED_KINDS = ["shadow-host", "canvas", "frame", "embed", "video"];

const MAX_SCANNED_ELEMENTS = 20000;
const MAX_REGIONS = 20;
const MAX_RECTS_PER_SHADOW_HOST = 4;
// An area is probed on a 5 x 5 grid (25 points) for what is drawn on top.
const AREA_PROBE_STEPS = 5;
const TAG_KINDS = { CANVAS: "canvas", IFRAME: "frame", FRAME: "frame", EMBED: "embed", OBJECT: "embed", VIDEO: "video" };
const RELATION_ORDER = ["covers-target", "overlaps-target", "none"];

// root: the element to scan (document.body). viewport: { width, height } in CSS
// px. overlay: the screenshot's targetOverlay (viewport-relative). topElementAt:
// (x, y) => the topmost page element at that viewport point, or null.
export function detectUncaptured(root, viewport, overlay, topElementAt) {
  const budget = { scanned: 0, truncated: false };
  const found = [];
  const stack = [root];
  while (stack.length) {
    const element = stack.pop();
    if (!countScanned(budget)) break;
    if (element !== root && element.matches(WIDGET_NODES)) continue;
    const kind = kindOf(element);
    if (kind) {
      const rects = kind === "shadow-host" ? shadowHostRects(element, viewport, budget) : [clippedRect(element, viewport)].filter(Boolean);
      if (rects.length) found.push({ element, kind, rects });
      // A candidate's own subtree is part of what goes missing (fallback
      // content, slotted light DOM), so it is not scanned for more.
      continue;
    }
    pushChildren(stack, element);
  }

  const points = targetPoints(overlay, viewport);
  const tops = points.map(([x, y]) => topElementAt(x, y)).filter(Boolean);
  const regions = found.map(({ element, kind, rects }) => ({
    kind,
    tag: element.localName,
    relation: relationOf(element, rects, overlay, tops),
    rects
  }));
  const counts = Object.fromEntries(UNCAPTURED_KINDS.map((kind) => [kind, regions.filter((region) => region.kind === kind).length]));
  // Keep the regions that touch the selected spot when there are too many.
  const ordered = RELATION_ORDER.flatMap((relation) => regions.filter((region) => region.relation === relation));

  return {
    version: UNCAPTURED_VERSION,
    status: "detected",
    scannedElements: budget.scanned,
    scanTruncated: budget.truncated,
    counts,
    regions: ordered.slice(0, MAX_REGIONS)
  };
}

function countScanned(budget) {
  if (budget.scanned >= MAX_SCANNED_ELEMENTS) {
    budget.truncated = true;
    return false;
  }
  budget.scanned += 1;
  return true;
}

function kindOf(element) {
  const tagKind = TAG_KINDS[element.tagName];
  if (tagKind) return tagKind;
  // Only open shadow roots are visible here; a closed one cannot be detected.
  return element.shadowRoot ? "shadow-host" : null;
}

function pushChildren(stack, element) {
  const children = element.children;
  for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
}

// A shadow host's own box says little: Next.js puts its dev overlay in a
// zero-size <nextjs-portal> whose shadow tree starts with a zero-size fixed
// wrapper. Walk the shadow tree breadth-first and take the first elements that
// have a box in the viewport, without descending into them. A host whose shadow
// tree has no box of its own may still paint itself through :host styles, so
// its own box is the fallback.
function shadowHostRects(host, viewport, budget) {
  const rects = [];
  const queue = Array.from(host.shadowRoot.children);
  while (queue.length && rects.length < MAX_RECTS_PER_SHADOW_HOST) {
    const element = queue.shift();
    if (!countScanned(budget)) break;
    const rect = clippedRect(element, viewport);
    if (rect) rects.push(rect);
    else queue.push(...Array.from(element.children));
  }
  if (rects.length) return rects;
  return [clippedRect(host, viewport)].filter(Boolean);
}

// The part of the element's box inside the viewport, or null when none is.
function clippedRect(element, viewport) {
  const box = element.getBoundingClientRect();
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(viewport.width, box.right);
  const bottom = Math.min(viewport.height, box.bottom);
  if (!(right > left) || !(bottom > top)) return null;
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  };
}

function targetPoints(overlay, viewport) {
  const points = overlay.kind === "area"
    ? Array.from({ length: AREA_PROBE_STEPS * AREA_PROBE_STEPS }, (_, index) => [
      overlay.x + (overlay.width * ((index % AREA_PROBE_STEPS) + 0.5)) / AREA_PROBE_STEPS,
      overlay.y + (overlay.height * (Math.floor(index / AREA_PROBE_STEPS) + 0.5)) / AREA_PROBE_STEPS
    ])
    : [[overlay.x, overlay.y]];
  return points.filter(([x, y]) => x >= 0 && y >= 0 && x < viewport.width && y < viewport.height);
}

function relationOf(element, rects, overlay, tops) {
  if (tops.some((top) => top === element || element.contains(top))) return "covers-target";
  if (rects.some((rect) => touchesTarget(rect, overlay))) return "overlaps-target";
  return "none";
}

function touchesTarget(rect, overlay) {
  if (overlay.kind === "area") {
    return rect.x < overlay.x + overlay.width && overlay.x < rect.x + rect.width
      && rect.y < overlay.y + overlay.height && overlay.y < rect.y + rect.height;
  }
  return overlay.x >= rect.x && overlay.x < rect.x + rect.width && overlay.y >= rect.y && overlay.y < rect.y + rect.height;
}
