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
  // Depth-first. Each frame walks one element's children by index, so the scan
  // touches no more elements than it counts, however many children there are.
  const stack = [{ children: [root], next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.next >= frame.children.length) {
      stack.pop();
      continue;
    }
    const element = frame.children[frame.next++];
    if (!countScanned(budget)) break;
    if (element !== root && element.matches(WIDGET_NODES)) continue;
    const kind = kindOf(element);
    if (kind) {
      const rects = kind === "shadow-host" ? shadowHostRects(element, viewport, budget) : [clippedRect(element, viewport)].filter(Boolean);
      if (rects.length) found.push({ element, kind, rects });
      // The children of canvas, frames, embeds and video are fallback content
      // that is not rendered, so they are not scanned. A shadow host's light
      // DOM is: slotted children render in the page (and the snapshot draws
      // them as plain children of the host), so it is scanned like any other.
      if (kind !== "shadow-host") continue;
    }
    stack.push({ children: element.children, next: 0 });
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

// A shadow host's own box says little: Next.js puts its dev overlay in a
// zero-size <nextjs-portal> whose shadow tree starts with a zero-size fixed
// wrapper. Walk the shadow tree breadth-first and take the first elements that
// have a box in the viewport, without descending into them. A zero-size element
// is looked through: its children, and its own open shadow tree when it hosts
// one (a component built from other components). A host whose shadow tree has
// no box may still paint itself through :host styles, so its own box is the
// fallback. Frames walk children by index, as in the main scan.
function shadowHostRects(host, viewport, budget) {
  const rects = [];
  const queue = [{ children: host.shadowRoot.children, next: 0 }];
  let head = 0;
  while (head < queue.length && rects.length < MAX_RECTS_PER_SHADOW_HOST) {
    const frame = queue[head];
    if (frame.next >= frame.children.length) {
      head += 1;
      continue;
    }
    const element = frame.children[frame.next++];
    if (!countScanned(budget)) break;
    const rect = clippedRect(element, viewport);
    if (rect) {
      rects.push(rect);
      continue;
    }
    queue.push({ children: element.children, next: 0 });
    if (element.shadowRoot) queue.push({ children: element.shadowRoot.children, next: 0 });
  }
  if (rects.length) return rects;
  return [clippedRect(host, viewport)].filter(Boolean);
}

// The part of the element's box inside the viewport in whole CSS px, or null
// when nothing is left. The edges are rounded before the size is taken, so a
// rectangle never reaches past the viewport.
function clippedRect(element, viewport) {
  const box = element.getBoundingClientRect();
  const left = Math.round(Math.max(0, box.left));
  const top = Math.round(Math.max(0, box.top));
  const right = Math.round(Math.min(viewport.width, box.right));
  const bottom = Math.round(Math.min(viewport.height, box.bottom));
  if (!(right > left) || !(bottom > top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
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
