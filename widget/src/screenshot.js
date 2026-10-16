import { state } from "./state.js";
import { freezeViewportUnits, flattenRulesForSnapshot } from "./snapshot-css.js";
import { detectUncaptured, UNCAPTURED_VERSION, WIDGET_NODES } from "./uncaptured.js";
import { escapeHtml, escapeXml } from "../../shared/format.js";

export function captureScreenshot(target) {
  if (!state.options.captureScreenshot) return null;

  try {
    const { width, height } = viewportSize();
    const documentWidth = Math.max(document.documentElement.scrollWidth, width);
    const documentHeight = Math.max(document.documentElement.scrollHeight, height);
    const overlay = screenshotOverlayFor(target);
    const uncaptured = uncapturedFor({ width, height }, overlay);
    const svg = buildScreenshotSvg({
      width,
      height,
      documentWidth,
      documentHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      overlay,
      uncaptured
    });
    const bytes = byteLength(svg);
    const maxBytes = Number(state.options.screenshotMaxBytes || 0);

    if (maxBytes > 0 && bytes > maxBytes) {
      return {
        status: "omitted",
        reason: "too-large",
        kind: "viewport-svg",
        mimeType: "image/svg+xml",
        width,
        height,
        bytes,
        maxBytes,
        targetOverlay: overlay
      };
    }

    return {
      status: "captured",
      kind: "viewport-svg",
      mimeType: "image/svg+xml",
      width,
      height,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      devicePixelRatio: window.devicePixelRatio || 1,
      bytes,
      targetOverlay: overlay,
      uncaptured,
      dataUrl: `data:image/svg+xml;base64,${base64Encode(svg)}`
    };
  } catch (error) {
    return {
      status: "failed",
      error: error.message
    };
  }
}

function buildScreenshotSvg({ width, height, documentWidth, documentHeight, scrollX, scrollY, overlay, uncaptured }) {
  const bodyClone = document.body.cloneNode(true);
  blankUnrenderedElements(document.body.querySelectorAll("*"), bodyClone.querySelectorAll("*"), (element) => hiddenPart(element), browserTextDirection(document));
  clearTemplateContents(bodyClone.querySelectorAll("template"));
  removeComments(bodyClone);
  bodyClone.querySelectorAll(`${WIDGET_NODES}, script`).forEach((node) => node.remove());
  bodyClone.querySelectorAll(".pl-target-highlight").forEach((node) => node.classList.remove("pl-target-highlight"));

  const bodyStyle = window.getComputedStyle(document.body);
  const rootStyle = window.getComputedStyle(document.documentElement);
  // A transparent body paints the html (or default white) background; the
  // snapshot must do the same instead of losing the page background.
  const background = visibleBackground(bodyStyle.backgroundColor)
    || visibleBackground(rootStyle.backgroundColor)
    || "#ffffff";
  const color = bodyStyle.color || "#14211d";
  const font = bodyStyle.font || bodyStyle.fontFamily || "system-ui, sans-serif";
  const htmlClassAttr = snapshotClassAttr(document.documentElement);
  const bodyClassAttr = snapshotClassAttr(document.body);
  // The <body> tag is regenerated, so its inline style must be carried
  // over; the snapshot's own layout overrides come after and win.
  const bodyInlineStyle = String(document.body.getAttribute("style") || "").trim();
  const bodyStylePrefix = bodyInlineStyle ? bodyInlineStyle.replace(/;?$/, ";") : "";
  const styles = `${freezeViewportUnits(collectReadableStyles(), width, height)}\n* { box-sizing: border-box; }\n`;
  const overlayMarkup = renderScreenshotOverlay(overlay);
  const uncapturedMarkup = renderUncapturedMarks(uncaptured, overlay, width, height);
  const bodyMarkup = serializeAsXhtml(bodyClone);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="${escapeXml(background)}"/>
<foreignObject x="0" y="0" width="${width}" height="${height}">
  <html xmlns="http://www.w3.org/1999/xhtml"${htmlClassAttr} style="width:${width}px;height:${height}px;overflow:hidden;background:${escapeHtml(background)};">
    <head>
      <style><![CDATA[${styles.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>
    </head>
    <body${bodyClassAttr} style="${escapeHtml(bodyStylePrefix)}margin:0;width:${documentWidth}px;min-height:${documentHeight}px;background:${escapeHtml(background)};color:${escapeHtml(color)};font:${escapeHtml(font)};${snapshotBodyOffsetStyle(bodyStyle, rootStyle.display, scrollX, scrollY)}">
      ${bodyMarkup}
    </body>
  </html>
</foreignObject>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#d9e1dd"/>
${uncapturedMarkup}
${overlayMarkup}
</svg>`;
}

// The elements the image will not show that touch the selected spot (#148), for
// the comment form to point the reviewer at before anything is sent. Nothing
// when the detection fails.
export function uncapturedTouching(target) {
  const record = uncapturedFor(viewportSize(), screenshotOverlayFor(target));
  return record.status === "detected" ? record.regions.filter((region) => region.relation !== "none") : [];
}

function viewportSize() {
  return {
    width: Math.max(document.documentElement.clientWidth, window.innerWidth, 1),
    height: Math.max(document.documentElement.clientHeight, window.innerHeight, 1)
  };
}

// What the image cannot show is recorded next to it (#148). Detecting it must
// not cost the screenshot, so a failure is recorded as such.
function uncapturedFor(viewport, overlay) {
  try {
    return detectUncaptured(document.body, viewport, overlay, topPageElementAt);
  } catch (error) {
    return { version: UNCAPTURED_VERSION, status: "failed", error: error.message };
  }
}

// The widget's comment form and the marker of the comment being written sit
// on the selected spot while the screenshot is taken, so they are skipped.
function topPageElementAt(x, y) {
  return document.elementsFromPoint(x, y).find((element) => !element.closest(WIDGET_NODES)) || null;
}

// Elements the page does not render (display:none: the hidden attribute, a
// <template>, a closed <dialog>, anything a stylesheet hides that way) are
// emptied in the snapshot (#122), and so are the contents of elements that
// skip rendering them (content-visibility: hidden, as hidden="until-found"
// gives, whose own box stays as it is), so the image file holds no more of them than
// the screen shows: every text in them becomes one character that keeps only
// its direction (blankText), the attributes that
// carry content become empty, comments go. Their
// elements and other attributes stay, and an emptied text is still there with
// its direction, so what the page's selectors match is unchanged (:empty,
// :nth-child, +, ~, :has(), [value], :dir()) and so is the direction dir="auto"
// and <bdi> work out from text, hidden text included; only a selector on such
// an attribute's value could differ.
// Kept as they are, wherever they are: SVG, whose hidden parts are often
// icons that <use> draws elsewhere; <style> and <link>, which style the page;
// form controls' values (<select> and its options, <textarea>, an <input>'s
// value and placeholder unless it is type=hidden), which decide the form's
// validity and :placeholder-shown, so styles on what is shown, and a <select>
// shows its selected option even when that option is hidden.
// originals and clones are the elements of the page's body and of its clone,
// in the same document order.
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const KEPT_UNRENDERED_TAGS = new Set(["STYLE", "LINK", "SELECT", "OPTION", "OPTGROUP", "TEXTAREA"]);
const FORM_STATE_ATTRIBUTES = new Set(["value", "placeholder"]);
const CONTENT_ATTRIBUTES = new Set([
  "value", "title", "alt", "placeholder", "href", "src", "srcset", "srcdoc", "data", "poster", "cite", "longdesc",
  "action", "formaction", "ping", "download", "content", "label", "aria-label", "aria-description", "aria-valuetext"
]);

// hidden: what of an element the page does not render (see hiddenPart);
// direction: a text's direction as dir="auto" sees it (see browserTextDirection).
export function blankUnrenderedElements(originals, clones, hidden, direction = approximateTextDirection) {
  if (originals.length !== clones.length) return;
  let blankedOriginal = null;
  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index];
    // Inside an element already emptied, with it.
    if (blankedOriginal && blankedOriginal.contains(original)) continue;
    const part = isBlankable(original) ? hidden(original) : null;
    if (!part) continue;
    blankedOriginal = original;
    if (part === "contents") blankChildren(clones[index], direction);
    else blankSubtree(clones[index], direction);
  }
}

function blankSubtree(element, direction) {
  blankAttributes(element);
  blankChildren(element, direction);
}

function blankAttributes(element) {
  const keepsFormState = element.tagName === "INPUT" && String(element.getAttribute("type") || "").toLowerCase() !== "hidden";
  element.getAttributeNames().forEach((name) => {
    const key = name.toLowerCase();
    if (CONTENT_ATTRIBUTES.has(key) && !(keepsFormState && FORM_STATE_ATTRIBUTES.has(key))) element.setAttribute(name, "");
  });
}

function blankChildren(element, direction) {
  Array.from(element.childNodes).forEach((child) => {
    if (child.nodeType === TEXT_NODE) {
      if (child.data) child.data = blankText(child.data, direction);
    } else if (child.nodeType === COMMENT_NODE) {
      child.remove();
    } else if (child.nodeType === ELEMENT_NODE && isBlankable(child)) {
      blankSubtree(child, direction);
    }
  });
}

function isBlankable(element) {
  return element.namespaceURI !== SVG_NAMESPACE && !KEPT_UNRENDERED_TAGS.has(element.tagName);
}

// A text's stand-in: an invisible mark of the direction dir="auto" takes from
// it, the direction of its first strong character (RLM for right-to-left, LRM
// for left-to-right), or one space when it has none (digits, punctuation and
// spaces are not strong).
export function blankText(data, direction = approximateTextDirection) {
  const found = direction(String(data));
  if (found === "rtl") return "\u200F";
  return found === "ltr" ? "\u200E" : " ";
}

// "rtl", "ltr" or null (no strong character) for a text, by the browser's own
// rules (Bidi_Class): a dir="auto" probe that is never attached, matched with
// :dir(). A right-to-left letter added at the end tells a text without a strong
// character from a left-to-right one. Where :dir() is not supported, by script.
export function browserTextDirection(doc) {
  let probe = null;
  return (data) => {
    try {
      if (!probe) {
        probe = doc.createElement("div");
        probe.setAttribute("dir", "auto");
      }
      probe.textContent = data;
      if (probe.matches(":dir(rtl)")) return "rtl";
      probe.textContent = `${data}\u05D0`;
      return probe.matches(":dir(rtl)") ? null : "ltr";
    } catch (_) {
      return approximateTextDirection(data);
    }
  };
}

// By script: letters of right-to-left scripts are right-to-left, other letters
// left-to-right. Close to the browser's rules, not the same.
const STRONG_CHARACTER = /[\p{L}\p{Nl}\u0640\u200E\u200F\u061C]/u;
const RIGHT_TO_LEFT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\u0640\u200F\u061C]/u;

export function approximateTextDirection(data) {
  const strong = String(data).match(STRONG_CHARACTER);
  if (!strong) return null;
  return RIGHT_TO_LEFT.test(strong[0]) ? "rtl" : "ltr";
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

// A <template>'s content is never rendered, wherever the template is, and
// selectors never reach into it (#122).
export function clearTemplateContents(templates) {
  Array.from(templates).forEach((template) => {
    if (template.content && typeof template.content.replaceChildren === "function") template.content.replaceChildren();
  });
}

// Comments are never rendered (#122); with or without them, selectors match
// the same.
export function removeComments(node) {
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType === COMMENT_NODE) child.remove();
    else if (child.nodeType === ELEMENT_NODE) removeComments(child);
  });
}

// "element" when the page does not render the element (display:none),
// "contents" when it renders the element's box but not what is inside
// (content-visibility: hidden, as hidden="until-found" gives), else null.
// content-visibility skips the contents only of some boxes: not of
// display:contents, inline, table, table-row, table-caption or ruby ones
// (checked in Chrome). Only the displays it was seen to skip count, and a child
// the browser says is shown (checkVisibility) means it did not; anything else
// keeps its contents, as the screen may show them.
const CONTENT_SKIPPING_DISPLAYS = new Set(["block", "flow-root", "list-item", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "table-cell"]);

export function hiddenPart(element, computedStyle = (node) => window.getComputedStyle(node)) {
  const style = computedStyle(element);
  if (style.display === "none") return "element";
  if (style.contentVisibility !== "hidden" || !CONTENT_SKIPPING_DISPLAYS.has(style.display)) return null;
  const shownChild = Array.from(element.children || []).some((child) => typeof child.checkVisibility === "function" && child.checkVisibility());
  return shownChild ? null : "contents";
}

function visibleBackground(value) {
  if (!value || value === "transparent" || value === "rgba(0, 0, 0, 0)") return "";
  return value;
}

function snapshotClassAttr(element) {
  // The widget's own mode class (crosshair cursor) is capture-state, not
  // page state, and must not leak into the snapshot.
  const value = String(element.getAttribute("class") || "")
    .split(/\s+/)
    .filter((token) => token && token !== "pl-feedback-active")
    .join(" ");
  return value ? ` class="${escapeHtml(value)}"` : "";
}

// The SVG is parsed as XML, so the clone must be serialized as XHTML:
// innerHTML emits HTML syntax (unclosed void elements like <br>, named
// entities like &nbsp;) that breaks XML parsing and renders the whole
// snapshot as a broken image. XMLSerializer self-closes void elements and
// emits characters instead of HTML-only entities.
function serializeAsXhtml(root) {
  const serializer = new XMLSerializer();
  return Array.from(root.childNodes)
    .map((node) => {
      try {
        return serializer.serializeToString(node);
      } catch (_) {
        return "";
      }
    })
    .join("");
}

// Media queries inside the snapshot re-evaluate against the SVG's rendered
// size (e.g. a scaled-down inbox preview), reflowing the clone away from the
// captured layout while overlay coordinates stay fixed. Resolve media
// conditions at capture time instead: inline the rules that match the
// current viewport and drop the rest, so the snapshot keeps the captured
// layout at any display size.
function collectReadableStyles() {
  const chunks = [];
  const mediaMatches = (mediaText) => window.matchMedia(mediaText).matches;
  const sheets = [...Array.from(document.styleSheets), ...Array.from(document.adoptedStyleSheets || [])];
  sheets.forEach((sheet) => {
    try {
      if (sheet.ownerNode?.dataset?.patchloopStyle) return;
      if (sheet.disabled) return;
      if (sheet.media && sheet.media.mediaText && !mediaMatches(sheet.media.mediaText)) return;
      const flattened = flattenRulesForSnapshot(sheet.cssRules, mediaMatches);
      if (flattened) chunks.push(flattened);
    } catch (_) {
      // Cross-origin stylesheets cannot be read. The snapshot still includes DOM and overlay context.
    }
  });
  return chunks.join("\n");
}

// Overlay coordinates must be viewport-relative at capture time, so derive
// them from the page-pixel position (kept fresh by re-anchoring) and the
// current scroll instead of the click-time client coordinates.
function screenshotOverlayFor(target) {
  if (target.kind === "area" && target.area) {
    return {
      kind: "area",
      x: Math.round(target.area.pageX - window.scrollX),
      y: Math.round(target.area.pageY - window.scrollY),
      width: Math.round(target.area.clientWidth),
      height: Math.round(target.area.clientHeight)
    };
  }

  return {
    kind: "point",
    x: Math.round(target.pageX - window.scrollX),
    y: Math.round(target.pageY - window.scrollY)
  };
}

// Elements the image cannot show that touch the selected spot (#148) get a
// dashed frame and a number: their place in uncaptured.regions, counted from 1,
// so text next to the image can point at them. The frame is dark over white to
// stay visible on any page; the selected spot's own mark is drawn above it, so
// numbers are placed clear of that mark and of each other (placeMarkNumber).
// Elements that do not touch the spot stay in the metadata only.
function renderUncapturedMarks(uncaptured, overlay, width, height) {
  if (!uncaptured || uncaptured.status !== "detected") return "";
  const marked = uncaptured.regions
    .map((region, index) => ({ region, number: index + 1 }))
    .filter(({ region }) => region.relation !== "none");
  // Every frame first, then every number, so no frame line crosses a number.
  const frames = marked.flatMap(({ region }) => region.rects.map(({ x, y, width: w, height: h }) => {
    const box = `x="${x + 1}" y="${y + 1}" width="${Math.max(1, w - 2)}" height="${Math.max(1, h - 2)}" fill="none"`;
    return `
<rect ${box} stroke="#ffffff" stroke-width="4"/>
<rect ${box} stroke="#14211d" stroke-width="2" stroke-dasharray="6 4"/>`;
  }));
  const taken = overlay ? overlayBoxes(overlay) : [];
  const numbers = marked.map(({ region, number }) => {
    const [labelX, labelY] = placeMarkNumber(region.rects[0], taken, width, height);
    taken.push({ x: labelX, y: labelY, width: MARK_NUMBER_SIZE, height: MARK_NUMBER_SIZE });
    return `
<rect x="${labelX}" y="${labelY}" width="20" height="20" rx="4" fill="#14211d" stroke="#ffffff" stroke-width="2"/>
<text x="${labelX + 10}" y="${labelY + 14}" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="12" font-weight="700">${number}</text>`;
  });
  return frames.join("") + numbers.join("");
}

const MARK_NUMBER_SIZE = 20;
const MARK_NUMBER_GAP = 4;

// The boxes the selected spot's mark covers, as renderScreenshotOverlay draws
// it: the point's outer ring, or the area's badge and its four border lines
// (3 px wide, with a pixel to spare). The area's translucent fill may sit over
// a number; it stays readable.
function overlayBoxes(overlay) {
  if (overlay.kind !== "area") return [{ x: overlay.x - 32, y: overlay.y - 32, width: 64, height: 64 }];
  const x = Math.max(0, overlay.x);
  const y = Math.max(0, overlay.y);
  const w = Math.max(1, overlay.width);
  const h = Math.max(1, overlay.height);
  return [
    { x, y, width: 36, height: 36 },
    { x: x - 3, y: y - 3, width: w + 6, height: 6 },
    { x: x - 3, y: y + h - 3, width: w + 6, height: 6 },
    { x: x - 3, y: y - 3, width: 6, height: h + 6 },
    { x: x + w - 3, y: y - 3, width: 6, height: h + 6 }
  ];
}

// Where a frame's number goes: just above its top-left corner, else just below
// the frame, else inside the corner; when all of these are taken (by the spot's
// mark or another number) or off the image, the free spot of a 24 px grid that
// is closest to the first choice.
function placeMarkNumber(rect, taken, width, height) {
  const size = MARK_NUMBER_SIZE;
  const step = size + MARK_NUMBER_GAP;
  const free = ([x, y]) => x >= 0 && y >= 0 && x + size <= width && y + size <= height
    && !taken.some((box) => x < box.x + box.width && box.x < x + size && y < box.y + box.height && box.y < y + size);
  const clampX = (x) => Math.max(0, Math.min(x, width - size));
  const preferred = [
    [clampX(rect.x), rect.y - step],
    [clampX(rect.x), rect.y + rect.height + MARK_NUMBER_GAP],
    [clampX(rect.x + MARK_NUMBER_GAP), rect.y + MARK_NUMBER_GAP]
  ];
  const chosen = preferred.find(free);
  if (chosen) return chosen;
  const [targetX, targetY] = preferred[0];
  let best = null;
  for (let y = 0; y + size <= height; y += step) {
    for (let x = 0; x + size <= width; x += step) {
      if (!free([x, y])) continue;
      const distance = (x - targetX) ** 2 + (y - targetY) ** 2;
      if (!best || distance < best.distance) best = { spot: [x, y], distance };
    }
  }
  // An image too small to have a free spot keeps the first choice, inside it.
  return best ? best.spot : [clampX(targetX), Math.max(0, Math.min(targetY, height - size))];
}

function renderScreenshotOverlay(overlay) {
  if (!overlay) return "";
  if (overlay.kind === "area") {
    const x = Math.max(0, overlay.x);
    const y = Math.max(0, overlay.y);
    const width = Math.max(1, overlay.width);
    const height = Math.max(1, overlay.height);
    return `
<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="rgba(209, 73, 91, 0.16)" stroke="#d1495b" stroke-width="3"/>
<circle cx="${x + 18}" cy="${y + 18}" r="14" fill="#d1495b" stroke="#ffffff" stroke-width="3"/>
<text x="${x + 18}" y="${y + 23}" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="13" font-weight="900">!</text>`;
  }

  return `
<circle cx="${overlay.x}" cy="${overlay.y}" r="18" fill="#d1495b" stroke="#ffffff" stroke-width="4"/>
<circle cx="${overlay.x}" cy="${overlay.y}" r="30" fill="none" stroke="#d1495b" stroke-width="3" opacity="0.35"/>`;
}

// Shift the cloned body to the scroll position. A transform did this before,
// but a transformed body becomes the containing block of its position:fixed
// descendants, so fixed and sticky elements (banners, badges, sticky headers)
// were laid out against the document top and scrolled out of the snapshot
// (#171). The placement only departs from the transform where the transform
// was wrong:
// - Every body stays a stacking context, as the transform made it, so negative
//   z-index children stay above its background. isolation does that without
//   making the body a containing block or touching its z-index.
// - Nothing needs shifting when the page is not scrolled (including
//   position:fixed; top:-500px to lock scrolling under a modal), so the body
//   is left exactly as the page placed it.
// - A scrolled static, relative or sticky body (the usual case) moves by
//   relative positioning. A relative body keeps its resolved offsets (a sticky
//   body's top is a threshold, not an offset), and right / bottom are cleared
//   so they cannot cancel left / top (a right-anchored body in an RTL page).
//   A z-index that applies to the body (positioned, or a flex / grid item of
//   html) is kept; one that did not apply to a static body is reset so the
//   new positioning does not activate it. !important beats page rules such
//   as body { position: static !important }.
// - A scrolled absolute or fixed body places and sizes itself from its own
//   offsets and containing block (left + right, a transformed html), so it
//   keeps the transform.
export function snapshotBodyOffsetStyle(bodyStyle, rootDisplay, scrollX, scrollY) {
  const x = Math.round(scrollX);
  const y = Math.round(scrollY);
  const isolation = "isolation:isolate !important;";
  if (x === 0 && y === 0) return isolation;
  const position = bodyStyle.position;
  if (position === "absolute" || position === "fixed") {
    return `transform:translate(${-x}px, ${-y}px);transform-origin:top left;`;
  }
  const relative = position === "relative";
  const zIndexApplies = relative || position === "sticky" || /\b(flex|grid)\b/.test(String(rootDisplay));
  const top = (relative ? offsetPixels(bodyStyle.top) : 0) - y;
  const left = (relative ? offsetPixels(bodyStyle.left) : 0) - x;
  return `position:relative !important;top:${top}px !important;left:${left}px !important;right:auto !important;bottom:auto !important;${zIndexApplies ? "" : "z-index:auto !important;"}${isolation}`;
}

// A resolved offset is a px length; "auto" (no offset) counts as 0.
function offsetPixels(value) {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? Math.round(pixels) : 0;
}

export function byteLength(value) {
  if (window.Blob) return new Blob([value]).size;
  return base64Encode(value).length;
}

export function base64Encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
