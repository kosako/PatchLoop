import { state } from "./state.js";
import { freezeViewportUnits, flattenRulesForSnapshot } from "./snapshot-css.js";
import { escapeHtml, escapeXml } from "../../shared/format.js";

export function captureScreenshot(target) {
  if (!state.options.captureScreenshot) return null;

  try {
    const width = Math.max(document.documentElement.clientWidth, window.innerWidth, 1);
    const height = Math.max(document.documentElement.clientHeight, window.innerHeight, 1);
    const documentWidth = Math.max(document.documentElement.scrollWidth, width);
    const documentHeight = Math.max(document.documentElement.scrollHeight, height);
    const overlay = screenshotOverlayFor(target);
    const svg = buildScreenshotSvg({
      width,
      height,
      documentWidth,
      documentHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      overlay
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
      dataUrl: `data:image/svg+xml;base64,${base64Encode(svg)}`
    };
  } catch (error) {
    return {
      status: "failed",
      error: error.message
    };
  }
}

function buildScreenshotSvg({ width, height, documentWidth, documentHeight, scrollX, scrollY, overlay }) {
  const bodyClone = document.body.cloneNode(true);
  bodyClone.querySelectorAll("[data-patchloop-root], [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection], script").forEach((node) => node.remove());
  bodyClone.querySelectorAll(".pl-target-highlight").forEach((node) => node.classList.remove("pl-target-highlight"));

  const bodyStyle = window.getComputedStyle(document.body);
  // A transparent body paints the html (or default white) background; the
  // snapshot must do the same instead of losing the page background.
  const background = visibleBackground(bodyStyle.backgroundColor)
    || visibleBackground(window.getComputedStyle(document.documentElement).backgroundColor)
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
  const bodyMarkup = serializeAsXhtml(bodyClone);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="${escapeXml(background)}"/>
<foreignObject x="0" y="0" width="${width}" height="${height}">
  <html xmlns="http://www.w3.org/1999/xhtml"${htmlClassAttr} style="width:${width}px;height:${height}px;overflow:hidden;background:${escapeHtml(background)};">
    <head>
      <style><![CDATA[${styles.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>
    </head>
    <body${bodyClassAttr} style="${escapeHtml(bodyStylePrefix)}margin:0;width:${documentWidth}px;min-height:${documentHeight}px;background:${escapeHtml(background)};color:${escapeHtml(color)};font:${escapeHtml(font)};transform:translate(${-Math.round(scrollX)}px, ${-Math.round(scrollY)}px);transform-origin:top left;">
      ${bodyMarkup}
    </body>
  </html>
</foreignObject>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#d9e1dd"/>
${overlayMarkup}
</svg>`;
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
