import { round } from "./geometry.js";
import { roundedAnchor } from "./anchoring.js";
import { state } from "./state.js";
import { captureScreenshot } from "./screenshot.js";
import { pageUrlForSharing } from "./url.js";
import { PAYLOAD_SCHEMA_VERSION } from "../../shared/versions.js";
import { LOCAL_ONLY_KEYS } from "../../shared/local-only.js";

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
    // Each comment's own copy: the rule is applied to it in place (#122).
    sourceContext: state.options.sourceContext ? { ...state.options.sourceContext } : null,
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
// does not skip the edit as a duplicate. The original's marks kept on this
// device only (LOCAL_ONLY_KEYS) do not carry over; previousIds lists every
// earlier version, so an edit another tab began on any of them follows to the
// latest revision.
export function buildRevision(original, comment, reviewer) {
  const revision = JSON.parse(JSON.stringify(original));
  LOCAL_ONLY_KEYS.forEach((key) => delete revision[key]);
  return {
    ...revision,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    id: generateFeedbackId(),
    replaces: original.id,
    previousIds: [...(Array.isArray(original.previousIds) ? original.previousIds : []), original.id],
    comment,
    reviewer
  };
}

// Date.now() alone collides across tabs/reviewers within the same
// millisecond, which also collides marker Map keys and orphans nodes.
function generateFeedbackId() {
  const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `pl_${Date.now()}_${random}`;
}
