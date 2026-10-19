"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createInboxView } = require("../server/inbox-view.js");

const { renderInbox } = createInboxView({
  GITHUB_CONFIGURED: true,
  authEnabled: true
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
  assert.match(elsewhere, /<dt>写らない要素<\/dt><dd>指摘箇所の外に 1 件、一覧にない 2 件（位置は不明）<\/dd>/);
  for (const screenshot of [undefined, { status: "omitted", reason: "too-large", bytes: 1, maxBytes: 1 }]) {
    assert.doesNotMatch(renderInbox([feedback({ screenshot })]), /写らない要素/);
  }
});

// A comment edited after it left the widget comes as a revision with replaces (#121).
// Card anchors are the id's UTF-16 code units in hex.
const anchor = (id) => `feedback-${Array.from({ length: id.length }, (_, index) => id.charCodeAt(index).toString(16).padStart(4, "0")).join("")}`;

function card(html, id) {
  const start = html.indexOf(`id="${anchor(id)}"`);
  assert.notEqual(start, -1, `card ${id}`);
  return html.slice(start, html.indexOf("</article>", start));
}

test("a replaced comment links to its revisions, and a revision to the comment it replaces (#121)", () => {
  const html = renderInbox([
    feedback({ id: "rev2", comment: "Second try", replaces: "orig" }),
    feedback({ id: "rev1", comment: "First try", replaces: "orig" }),
    feedback({ id: "orig", comment: "Original" })
  ]);
  const links = [...card(html, "orig").matchAll(/<a href="#([^"]+)" data-card-link data-link-role="revision" data-target-id="([^"]+)">([^<]+)<\/a>/g)].map((match) => match.slice(1));
  assert.deepEqual(links, [[anchor("rev2"), "rev2", "修正版 1"], [anchor("rev1"), "rev1", "修正版 2"]]);
  assert.match(card(html, "orig"), /このコメントには修正版があります: <span data-revision-links>/);
  assert.ok(card(html, "rev1").includes(`<a href="#${anchor("orig")}" data-card-link data-link-role="original" data-target-id="orig">元のコメント</a>の修正版です。`));
  assert.match(card(html, "rev1"), /<dt>Replaces<\/dt><dd><code>orig<\/code><\/dd>/);
  assert.doesNotMatch(card(html, "rev1"), /修正版があります/);
});

test("a revision whose original is not in this inbox says so, and odd ids stay text", () => {
  const html = renderInbox([feedback({ id: "a\"b<c", comment: "Revised", replaces: "gone<script>" })]);
  assert.match(html, /元のコメント（<code>gone&lt;script&gt;<\/code>、この受信箱には無い）の修正版です。/);
  assert.ok(html.includes(`id="${anchor("a\"b<c")}"`));
});

test("card anchors are plain ASCII and distinct for any id, and never throw (#121)", () => {
  const ids = ["a\rb", "a\nb", "x y", "\ud800lone", "日本"];
  const html = renderInbox([...ids.map((id) => feedback({ id, comment: id })), feedback({ id: "rev", replaces: "\ud800lone" })]);
  const anchors = [...html.matchAll(/<article class="card" id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(anchors).size, ids.length + 1);
  for (const value of anchors) assert.match(value, /^feedback-[0-9a-f]+$/);
  assert.ok(html.includes(`href="#${anchor("\ud800lone")}"`));
});

test("a stored replaces that is not a string does not break the card", () => {
  const html = renderInbox([feedback({ id: "odd", comment: "Kept", replaces: { toString: 1 } })]);
  assert.match(html, /data-status-select data-feedback-id="odd"/);
  assert.doesNotMatch(html, /修正版/);
});

test("the logout button shows only when the inbox has a login (#170)", () => {
  const logout = 'action="/logout"';
  assert.equal(renderInbox([feedback()]).includes(logout), true);
  const withoutLogin = createInboxView({ GITHUB_CONFIGURED: true, authEnabled: false }).renderInbox([feedback()]);
  assert.equal(withoutLogin.includes(logout), false);
});
