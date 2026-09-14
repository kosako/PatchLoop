"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createInboxView } = require("../server/inbox-view.js");

const { renderInbox } = createInboxView({
  formatScreenshotStatus: (screenshot) => screenshot.status,
  safeLinkUrl: (value) => /^https?:\/\//.test(String(value || "")) ? value : "",
  GITHUB_CONFIGURED: true,
  RECEIVER_TOKEN: "synthetic-token"
});

function feedback(extra = {}) {
  return { id: "one", comment: "Example", reviewer: "Reviewer", target: { kind: "point" }, page: {}, environment: {}, ...extra };
}

test("inbox controls have accessible names and import results have a live region", () => {
  const html = renderInbox([feedback()]);
  const controls = [...html.matchAll(/<(?:input|select)\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(controls.length, 11);
  for (const control of controls) assert.match(control, /aria-label="[^"]+"/);
  const importStatus = html.match(/<span\b[^>]*data-import-status[^>]*>/)[0];
  assert.match(importStatus, /role="status"/);
  assert.match(importStatus, /aria-live="polite"/);
  assert.match(importStatus, /aria-atomic="true"/);
});

test("empty state and total hooks reflect the initial number of feedback cards", () => {
  const empty = renderInbox([]);
  assert.match(empty, /data-total-count>0<\/span>/);
  assert.match(empty, /<p class="empty" data-inbox-empty>/);
  assert.doesNotMatch(empty, /data-filter-panel/);
  const populated = renderInbox([feedback()]);
  assert.match(populated, /data-total-count>1<\/span>/);
  assert.match(populated, /data-inbox-empty hidden/);
  assert.match(populated, /data-filter-panel/);
});

test("saved screenshots use encoded same-origin paths without changing stored external URLs", () => {
  const screenshot = {
    status: "saved", fileName: "capture #&\".svg", url: "https://previous.example/screenshots/old.svg",
    width: 100, height: 50
  };
  const html = renderInbox([feedback({ screenshot })]);
  const expected = "/screenshots/capture%20%23%26%22.svg";
  assert.ok(html.includes(`<img src="${expected}"`));
  assert.ok(html.includes(`<a href="${expected}"`));
  assert.equal(screenshot.url, "https://previous.example/screenshots/old.svg");
  assert.doesNotMatch(html, /(?:src|href)="https:\/\/previous\.example/);
});

test("screenshots without a server-owned filename do not load a stored external URL", () => {
  for (const fileName of [undefined, null, "", {}]) {
    const html = renderInbox([feedback({ screenshot: { status: "saved", fileName, url: "https://external.example/image.svg" } })]);
    assert.doesNotMatch(html, /<img\b/);
    assert.match(html, /Screenshot: saved/);
  }
});
