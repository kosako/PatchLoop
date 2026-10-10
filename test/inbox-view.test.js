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

function savedScreenshot(extra = {}) {
  return { status: "saved", fileName: "shot.svg", width: 800, height: 600, bytes: 100, ...extra };
}

function uncapturedRecord(regions, counts = { "shadow-host": 1, canvas: 1, frame: 0, embed: 0, video: 0 }) {
  return { version: 1, status: "detected", scannedElements: 10, scanTruncated: false, counts, regions };
}

test("a card notes elements the screenshot cannot show that touch the selected spot (#148)", () => {
  const html = renderInbox([feedback({
    screenshot: savedScreenshot({
      uncaptured: uncapturedRecord([
        { kind: "shadow-host", tag: "x-<b>portal</b>", relation: "covers-target", rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
        { kind: "canvas", tag: "canvas", relation: "none", rects: [{ x: 0, y: 0, width: 10, height: 10 }] }
      ])
    })
  })]);
  const note = html.match(/<p class="uncaptured-note">([^<]*(?:<(?!\/p>)[^<]*)*)<\/p>/);
  assert.ok(note, "the note is shown");
  assert.match(note[1], /指摘箇所に重なっている可能性があります/);
  assert.match(note[1], /1\. x-&lt;b&gt;portal&lt;\/b&gt;（shadow DOM・指摘箇所の最前面）/);
  assert.doesNotMatch(note[1], /2\. canvas/);
  assert.match(html, /<dt>写らない要素<\/dt><dd>指摘箇所に 1 件、ほかに 1 件<\/dd>/);
});

test("a card's details tell none, not checked and failed apart, and say nothing without a saved screenshot (#148)", () => {
  const none = renderInbox([feedback({ screenshot: savedScreenshot({ uncaptured: uncapturedRecord([], { "shadow-host": 0, canvas: 0, frame: 0, embed: 0, video: 0 }) }) })]);
  assert.match(none, /<dt>写らない要素<\/dt><dd>なし<\/dd>/);
  assert.doesNotMatch(none, /class="uncaptured-note"/);
  const notChecked = renderInbox([feedback({ screenshot: savedScreenshot() })]);
  assert.match(notChecked, /<dt>写らない要素<\/dt><dd>未確認（この確認より前の widget）<\/dd>/);
  const failed = renderInbox([feedback({ screenshot: savedScreenshot({ uncaptured: { version: 1, status: "failed" } }) })]);
  assert.match(failed, /<dt>写らない要素<\/dt><dd>検知に失敗<\/dd>/);
  const elsewhere = renderInbox([feedback({ screenshot: savedScreenshot({ uncaptured: uncapturedRecord([{ kind: "canvas", tag: "canvas", relation: "none", rects: [{ x: 0, y: 0, width: 10, height: 10 }] }], { "shadow-host": 0, canvas: 3, frame: 0, embed: 0, video: 0 }) }) })]);
  assert.match(elsewhere, /<dt>写らない要素<\/dt><dd>指摘箇所の外に 3 件<\/dd>/);
  for (const screenshot of [undefined, { status: "omitted", reason: "too-large", bytes: 1, maxBytes: 1 }]) {
    assert.doesNotMatch(renderInbox([feedback({ screenshot })]), /写らない要素/);
  }
});
