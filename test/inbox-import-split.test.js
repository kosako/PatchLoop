"use strict";

// A file over the receiver's request limit is imported in parts (#140), so a
// download-mode export with several screenshots still reaches the inbox.

const assert = require("node:assert/strict");
const test = require("node:test");
const { inboxHarness } = require("../test-support/inbox-dom.js");

const byteLength = (text) => Buffer.byteLength(text, "utf8");

function comment(index, createdAt) {
  return { id: `pl_${index}`, comment: `Comment ${index} ${"x".repeat(60)}`, createdAt, target: { kind: "point" } };
}

// The widget writes the newest comment first.
const bundle = (feedback) => ({ kind: "patchloop-feedback-bundle", version: 2, exportedAt: "2026-10-13T00:00:00.000Z", projectId: "p", demoId: "d", feedback });
const FIVE = [5, 4, 3, 2, 1].map((index) => comment(index, `2026-10-0${index}T00:00:00.000Z`));

// The receiver's answer to a part: everything in it imported.
const importsAll = (options) => {
  const body = JSON.parse(options.body);
  const feedback = Array.isArray(body) ? body : body.feedback;
  return { ok: true, status: 201, body: { imported: feedback.length, duplicates: [], failed: [] } };
};

async function importFile(ui, value) {
  ui.get("[data-import-file]").files = [{ text: async () => (typeof value === "string" ? value : JSON.stringify(value)) }];
  await ui.submit(ui.get("[data-import-form]"));
  return ui.get("[data-import-status]");
}

const sentParts = (ui) => ui.requests.map((request) => JSON.parse(request.options.body));

test("a file within the limit is sent once, as it is", async () => {
  const ui = inboxHarness([], { replies: [importsAll] });
  const text = JSON.stringify(bundle(FIVE), null, 2);
  const status = await importFile(ui, text);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].options.body, text);
  assert.equal(status.textContent, "5 件を追加しました。「受信箱を更新」で一覧に反映します。");
});

test("a file over the limit is sent in parts that fit, each a bundle of the same kind, every comment once", async () => {
  const maxBodyBytes = 400;
  const ui = inboxHarness([], { maxBodyBytes, replies: Array(10).fill(importsAll) });
  const status = await importFile(ui, bundle(FIVE));

  const parts = sentParts(ui);
  assert.ok(parts.length > 1);
  ui.requests.forEach((request) => assert.ok(byteLength(request.options.body) <= maxBodyBytes));
  parts.forEach((part) => assert.deepEqual([part.kind, part.version, part.projectId, part.demoId], ["patchloop-feedback-bundle", 2, "p", "d"]));
  assert.deepEqual(parts.flatMap((part) => part.feedback.map((item) => item.id)).sort(), FIVE.map((item) => item.id).sort());
  assert.equal(status.dataset.state, "success");
  assert.equal(status.textContent, "5 件を追加しました。「受信箱を更新」で一覧に反映します。");
  assert.equal(ui.get("[data-import-reload]").hidden, false);
});

test("the parts go oldest first and each lists its comments as the file does, so the inbox keeps the order of one request (#156)", async () => {
  const shuffled = [3, 5, 1, 4, 2].map((index) => comment(index, `2026-10-0${index}T00:00:00.000Z`));
  const ui = inboxHarness([], { maxBodyBytes: 400, replies: Array(10).fill(importsAll) });
  await importFile(ui, bundle(shuffled));

  // The receiver reverses a request and sorts it oldest first (stable).
  const inserted = sentParts(ui).flatMap((part) => part.feedback.slice().reverse());
  assert.deepEqual(inserted.map((item) => item.id), ["pl_1", "pl_2", "pl_3", "pl_4", "pl_5"]);
});

test("parts also keep to the receiver's item limit, and a plain array file is split as an array", async () => {
  // 600 bytes fit three of these comments; the item limit keeps parts to two.
  const ui = inboxHarness([], { maxBodyBytes: 600, maxImportItems: 2, replies: Array(10).fill(importsAll) });
  await importFile(ui, FIVE);
  const parts = sentParts(ui);
  assert.deepEqual(parts.map((part) => Array.isArray(part) && part.length), [2, 2, 1]);
  assert.equal(parts.flat().length, 5);
});

test("a comment over the limit by itself fails alone and the message tells how to raise the limit", async () => {
  const huge = { ...comment(9, "2026-10-09T00:00:00.000Z"), comment: "y".repeat(500) };
  const replies = Array(10).fill((options) => (byteLength(options.body) > 400
    ? { ok: false, status: 413, body: { ok: false, error: "Payload too large" } }
    : importsAll(options)));
  const ui = inboxHarness([], { maxBodyBytes: 400, replies });
  const status = await importFile(ui, bundle([huge, ...FIVE]));

  assert.equal(status.dataset.state, "error");
  assert.match(status.textContent, /^5 件を追加しました。失敗 1 件。コメント 1 件で受信側の上限（400 byte）を超えています。receiver の MAX_BODY_BYTES/);
  assert.equal(ui.get("[data-import-reload]").hidden, false);
});

test("a file of one comment over the limit is sent whole and explained", async () => {
  const huge = { ...comment(9, "2026-10-09T00:00:00.000Z"), comment: "y".repeat(500) };
  const ui = inboxHarness([], { maxBodyBytes: 400, replies: [{ ok: false, status: 413, body: { ok: false, error: "Payload too large" } }] });
  const status = await importFile(ui, bundle([huge]));
  assert.equal(ui.requests.length, 1);
  assert.equal(status.dataset.state, "error");
  assert.match(status.textContent, /^コメント 1 件で受信側の上限（400 byte）を超えています。/);
});

test("a stop part way says how many were added and that importing again skips them", async () => {
  const ui = inboxHarness([], { maxBodyBytes: 600, maxImportItems: 2, replies: [importsAll, { ok: false, status: 401, body: {} }] });
  const status = await importFile(ui, bundle(FIVE));
  assert.equal(ui.requests.length, 2);
  assert.equal(status.dataset.state, "error");
  assert.match(status.textContent, /^2 件を追加したところで止まりました。ログインの有効期限が切れています。.*もう一度読み込むと、追加済みのものは重複としてスキップされます。$/);
  assert.equal(ui.get("[data-import-reload]").hidden, false);
});
