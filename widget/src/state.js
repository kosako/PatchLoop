import { initialLookupState } from "./inbox-status.js";

export const DEFAULTS = {
  projectId: "local-demo",
  demoId: "plain-html",
  endpoint: "",
  // Public per-project key sent with receiver posts (#44). It ships in the
  // page, so it identifies the project and blocks indiscriminate spam rather
  // than acting as a secret. Empty = receiver runs with open ingest.
  ingestKey: "",
  // Git provenance of the page under review (#96): { repo, branch, commit,
  // root, buildUrl, previewUrl }, all optional strings. The embedding side
  // injects real values at build/deploy time; <meta name="patchloop:..."> tags
  // fill any missing field.
  sourceContext: null,
  // Query keys kept in page.url (#163), e.g. ["step"] for an app that keeps
  // the screen state in `?step=`. Every other query and the fragment are
  // dropped. Kept values are shared as-is, so list no key that carries a secret.
  keepQueryParams: [],
  deliveryMode: "receiver",
  slackWebhookUrl: "",
  showDeliverySettings: false,
  reviewer: "",
  reviewerStorageKey: "patchloop:reviewer",
  // The longest comment and name, in string.length (#196). The receiver's
  // default maxFieldLength; a receiver set otherwise needs the same value here.
  maxFieldLength: 20_000,
  persistFeedback: true,
  feedbackStorageKey: "patchloop:feedback",
  captureScreenshot: true,
  screenshotMaxBytes: 1_200_000,
  onSubmit: null
};

export const state = {
  options: { ...DEFAULTS },
  active: false,
  pendingTarget: null,
  drag: null,
  suppressNextClick: false,
  feedback: [],
  feedbackMarkers: new Map(),
  // Comments whose marker is only near its place, with why (#200): "missing"
  // (its element cannot be found) or "viewport" (the window size differs).
  approximateIds: new Map(),
  resizeTimer: null,
  // Tries again to place markers whose element is not drawn yet (#200).
  missingRetryTimer: null,
  editingId: null,
  commentReturnFocus: null,
  collapsed: true,
  displayMode: "normal",
  // "button" (the collapsed panel's button) or "tab" (tucked into a small tab
  // at the screen's edge, #211).
  launcher: "button",
  // Inbox triage status (#147): { statuses: Map(id -> status), asked: Set(id) }
  // after a successful lookup, null otherwise. Kept in memory only.
  inboxStatus: null,
  statusLookup: initialLookupState(),
  // The lookup request in flight, if any; see refreshInboxStatuses.
  statusLookupRequest: null,
  // The comment form's note about elements the screenshot will not show (#148),
  // shown while the screenshot is included.
  uncapturedHint: "",
  // { total, unexported } of the comments saved by the other pages of the demo
  // (#197); null until counted again.
  otherPages: null,
  otherPagesTimer: null,
  // { key, pageUrl } of the page whose saved list is in memory (#197), fixed by
  // init; see bindFeedbackScope.
  feedbackScope: null,
  // The comments in storage when this tab last read or wrote it (id to
  // fingerprints), and the ids this tab is delivering, for the merge with
  // other tabs (#139).
  storedFeedback: new Map(),
  deliveringIds: new Set(),
  // Re-checks a delivery another tab may still be making, and when this tab
  // first saw each such delivery (monotonic); see settlePendingDeliveries.
  pendingCheckTimer: null,
  pendingSeenAt: new Map(),
  // Markers following content that moves under them (#213): the frame asked
  // for, until when (and at the latest) to keep following, and the count of
  // followings, which tells when to look elements up again.
  follow: { frame: null, until: 0, limit: 0, session: 0 }
};
