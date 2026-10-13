import { round } from "./geometry.js";
import { roundedAnchor } from "./anchoring.js";
import { state } from "./state.js";
import { captureScreenshot } from "./screenshot.js";
import { pageUrlForSharing } from "./url.js";

// Version of the feedback payload schema itself (distinct from the storage
// envelope and export bundle versions). Bump when the payload shape changes
// so the receiver can branch on it as the schema grows for team use.
// v2 adds the optional sourceContext block (#96).
// v3 adds screenshot.uncaptured (#148).
// v4 adds replaces, on the revision of a comment edited after it left this
// device (#121).
const PAYLOAD_SCHEMA_VERSION = 4;

export function buildPayload(comment, reviewer, target, includeScreenshot = state.options.captureScreenshot) {
  return {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    id: generateFeedbackId(),
    projectId: state.options.projectId,
    demoId: state.options.demoId,
    comment,
    reviewer,
    page: {
      url: pageUrlForSharing(window.location.href, state.options.keepQueryParams),
      title: document.title
    },
    sourceContext: state.options.sourceContext,
    target: {
      kind: target.kind || "point",
      x: round(target.x),
      y: round(target.y),
      clientX: Math.round(target.clientX),
      clientY: Math.round(target.clientY),
      pageX: Math.round(target.pageX),
      pageY: Math.round(target.pageY),
      documentX: round(target.documentX),
      documentY: round(target.documentY),
      area: target.area || null,
      selector: target.selector,
      text: target.elementText,
      anchor: roundedAnchor(target.anchor)
    },
    environment: {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      browser: navigator.userAgent,
      language: navigator.language
    },
    screenshot: includeScreenshot ? captureScreenshot(target) : null,
    createdAt: new Date().toISOString()
  };
}

// The revision of a comment edited after it left this device (#121): a new
// comment with the same place, page, image and creation time, pointing at the
// one it replaces, so what the receiver holds is never rewritten and an import
// does not skip the edit as a duplicate.
export function buildRevision(original, comment, reviewer) {
  const revision = JSON.parse(JSON.stringify(original));
  ["delivery", "exported", "exportedAt", "exportedFileName", "localEdited"].forEach((key) => delete revision[key]);
  return { ...revision, schemaVersion: PAYLOAD_SCHEMA_VERSION, id: generateFeedbackId(), replaces: original.id, comment, reviewer };
}

// Date.now() alone collides across tabs/reviewers within the same
// millisecond, which also collides marker Map keys and orphans nodes.
function generateFeedbackId() {
  const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `pl_${Date.now()}_${random}`;
}
