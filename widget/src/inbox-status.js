// The inbox triage status of the comments this page sent (#147), asked from
// the receiver's POST /feedback-status. The statuses only live in memory: they
// are never written to the stored items, localStorage or exports, and when they
// cannot be had the widget hides nothing. This module holds the decisions;
// index.js does the request and the drawing.

import { FEEDBACK_STATUS_LABELS } from "../../shared/format.js";

export const FINISHED_STATUSES = ["fixed", "ignored"];
// The receiver answers at most 200 ids per query; the newest comments go first.
const MAX_LOOKUP_IDS = 200;
// Lookups run on load, when the panel opens and when the tab comes back, but
// no closer together than this; failures back off up to the maximum.
export const LOOKUP_MIN_GAP_MS = 30_000;
export const LOOKUP_MAX_GAP_MS = 10 * 60_000;

// The lookup sits next to POST /feedback on the receiver. No endpoint, or one
// whose path does not end in /feedback, has no known lookup URL. baseUrl is the
// one fetch resolves a relative endpoint against (document.baseURI).
export function statusLookupUrl(endpoint, baseUrl) {
  if (!String(endpoint || "").trim()) return null;
  let url;
  try {
    url = new URL(endpoint, baseUrl);
  } catch (_) {
    return null;
  }
  if (!url.pathname.endsWith("/feedback")) return null;
  url.pathname = `${url.pathname}-status`;
  url.search = "";
  url.hash = "";
  return url.href;
}

// Comments the receiver has: delivered, or refused as an id it already holds.
export function statusLookupIds(feedback) {
  return feedback
    .filter((item) => item.delivery && (item.delivery.ok === true || item.delivery.status === 409))
    .slice(0, MAX_LOOKUP_IDS)
    .map((item) => item.id);
}

// The id -> status pairs of a successful answer, or null when the answer does
// not have the expected shape. Unknown statuses are left out.
export function statusesFromAnswer(body) {
  if (!body || body.ok !== true || !Array.isArray(body.statuses)) return null;
  const statuses = new Map();
  for (const entry of body.statuses) {
    if (entry && typeof entry.id === "string" && Object.prototype.hasOwnProperty.call(FEEDBACK_STATUS_LABELS, entry.status)) {
      statuses.set(entry.id, entry.status);
    }
  }
  return statuses;
}

// Handled in the inbox, unless the comment was edited here since: that edit
// has not reached the inbox.
export function isFinished(item, statuses) {
  return Boolean(statuses) && FINISHED_STATUSES.includes(statuses.get(item.id)) && !item.localEdited;
}

export function initialLookupState() {
  return { stopped: false, failures: 0, nextAt: 0 };
}

// outcome: "ok", "unavailable" (the receiver has no lookup for this page:
// 401 / 403 / 404, so asking again will not help) or "failed" (anything else:
// network errors, timeouts, 5xx, 429, a malformed answer).
export function lookupOutcome(httpStatus, statuses) {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) return "unavailable";
  return httpStatus === 200 && statuses ? "ok" : "failed";
}

export function lookupAfter(lookup, outcome, now) {
  if (outcome === "unavailable") return { ...lookup, stopped: true };
  const failures = outcome === "ok" ? 0 : lookup.failures + 1;
  return { stopped: false, failures, nextAt: now + Math.min(LOOKUP_MIN_GAP_MS * 2 ** failures, LOOKUP_MAX_GAP_MS) };
}
