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
  deliveryMode: "receiver",
  slackWebhookUrl: "",
  showDeliverySettings: false,
  reviewer: "",
  reviewerStorageKey: "patchloop:reviewer",
  persistFeedback: true,
  feedbackStorageKey: "patchloop:feedback",
  position: "bottom-right",
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
  approximateIds: new Set(),
  resizeTimer: null,
  editingId: null,
  collapsed: true
};
