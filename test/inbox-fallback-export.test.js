"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createInboxView } = require("../server/inbox-view.js");

test("legacy fallback cards use the public serializer for their raw payload", () => {
  const { renderInbox } = createInboxView({
    formatScreenshotStatus: (screenshot) => screenshot.status,
    safeLinkUrl: () => "",
    GITHUB_CONFIGURED: false,
    RECEIVER_TOKEN: ""
  });
  const item = {
    id: "legacy", comment: "Legacy feedback", reviewer: "Reviewer",
    target: { kind: "point" }, page: {},
    environment: { viewport: { width: { toString: 1 }, height: 50 } },
    screenshot: { status: "saved", fileName: "legacy.svg", path: "internal-image-location" }
  };
  const healthy = { id: "healthy", comment: "Healthy feedback", reviewer: "Reviewer", target: { kind: "point" }, page: {}, environment: {} };
  const html = renderInbox([item, healthy]);
  assert.match(html, /data-feedback-id="legacy"/);
  assert.match(html, /data-feedback-id="healthy"/);
  assert.match(html, /&quot;toString&quot;: 1/);
  assert.equal(html.includes("internal-image-location"), false);
  assert.equal(item.screenshot.path, "internal-image-location");
});
