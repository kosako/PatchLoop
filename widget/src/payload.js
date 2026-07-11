import { round } from "./geometry.js";
import { roundedAnchor } from "./anchoring.js";
import { state } from "./state.js";
import { captureScreenshot } from "./screenshot.js";

// Version of the feedback payload schema itself (distinct from the storage
// envelope and export bundle versions). Bump when the payload shape changes
// so the receiver can branch on it as the schema grows for team use.
// v2 adds the optional sourceContext block (#96).
const PAYLOAD_SCHEMA_VERSION = 2;

export function buildPayload(comment, reviewer, target) {
  return {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    id: generateFeedbackId(),
    projectId: state.options.projectId,
    demoId: state.options.demoId,
    comment,
    reviewer,
    page: {
      url: window.location.href,
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
    screenshot: captureScreenshot(target),
    createdAt: new Date().toISOString()
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
