"use strict";

// A file over the receiver's request limit is imported in parts (#140), so a
// download-mode export with several screenshots still reaches the inbox.
// test/receiver.test.js sends such parts to a real receiver as well.

const assert = require("node:assert/strict");
const test = require("node:test");
const { inboxHarness } = require("../test-support/inbox-dom.js");

const byteLength = (text) => Buffer.byteLength(text, "utf8");

// A comment as the widget saves it, which the receiver accepts.
function comment(index, createdAt, text = `Comment ${index}`) {
  return {
    schemaVersion: 3, id: `pl_${index}`, projectId: "p", demoId: "d", comment: text, reviewer: "Reviewer",
    page: { url: "https://demo.example/page", title: "Page" },
    target: { kind: "point", x: 1, y: 1, clientX: 10, clientY: 10, pageX: 10, pageY: 10, documentX: 1, documentY: 1, selector: "#a", text: "A" },
    environment: { viewport: { width: 800, height: 600 }, browser: "test", language: "ja" },
    screenshot: null, createdAt
  };
}

// The widget writes the newest comment first.
const bundle = (feedback) => ({ kind: "patchloop-feedback-bundle", version: 2, exportedAt: "2026-10-13T00:00:00.000Z", projectId: "p", demoId: "d", feedback });
const FIVE = [5, 4, 3, 2, 1].map((index) => comment(index, `2026-10-0${index}T00:00:00.000Z`));
const ONE = byteLength(JSON.stringify(bundle(FIVE.slice(0, 1))));
const TWO = byteLength(JSON.stringify(bundle(FIVE.slice(0, 2))));

// The receiver's answer to a part: each id imported once, later copies duplicates.
const importsAll = (options) => {
  const ids = new Set();
  const duplicates = [];
  for (const item of JSON.parse(options.body).feedback) {
    if (ids.has(item.id)) duplicates.push(item.id);
    ids.add(item.id);
  }
  return { ok: true, status: 201, body: { imported: ids.size, duplicates, failed: [] } };
};
const busy = { ok: false, status: 429, body: {} };
const tooLarge = { ok: false, status: 413, body: { ok: false, error: "Payload too large" } };

async function importFile(ui, value) {
  ui.get("[data-import-file]").files = [{ text: async () => (typeof value === "string" ? value : JSON.stringify(value)) }];
  await ui.submit(ui.get("[data-import-form]"));
  return ui.get("[data-import-status]");
}

const sentParts = (ui) => ui.requests.map((request) => JSON.parse(request.options.body));
const sentIds = (ui) => sentParts(ui).flatMap((part) => part.feedback.map((item) => item.id));

test("a file within the limit is sent once, as it is", async () => {
  const ui = inboxHarness([], { replies: [importsAll] });
  const text = JSON.stringify(bundle(FIVE), null, 2);
  const status = await importFile(ui, text);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].options.body, text);
  assert.equal(status.textContent, "5 件を追加しました。「受信箱を更新」で一覧に反映します。");
});

test("a file over the limit is sent in parts that fit, each a copy of the bundle, every comment once", async () => {
  const ui = inboxHarness([], { maxBodyBytes: TWO, replies: Array(10).fill(importsAll) });
  const status = await importFile(ui, bundle(FIVE));

  const parts = sentParts(ui);
  assert.equal(parts.length, 3);
  ui.requests.forEach((request) => assert.ok(byteLength(request.options.body) <= TWO));
  parts.forEach((part) => assert.deepEqual([part.kind, part.version, part.exportedAt, part.projectId, part.demoId], ["patchloop-feedback-bundle", 2, "2026-10-13T00:00:00.000Z", "p", "d"]));
  assert.deepEqual(sentIds(ui).sort(), FIVE.map((item) => item.id).sort());
  assert.equal(status.dataset.state, "success");
  assert.equal(status.textContent, "5 件を追加しました。「受信箱を更新」で一覧に反映します。");
  assert.equal(ui.get("[data-import-reload]").hidden, false);
});

test("the parts go oldest first and each lists its comments as the file does, so the inbox keeps the order of one request (#156)", async () => {
  const shuffled = [3, 5, 1, 4, 2].map((index) => comment(index, `2026-10-0${index}T00:00:00.000Z`));
  const ui = inboxHarness([], { maxBodyBytes: TWO, replies: Array(10).fill(importsAll) });
  await importFile(ui, bundle(shuffled));

  // The receiver reverses a request and sorts it oldest first (stable).
  const inserted = sentParts(ui).flatMap((part) => part.feedback.slice().reverse());
  assert.deepEqual(inserted.map((item) => item.id), ["pl_1", "pl_2", "pl_3", "pl_4", "pl_5"]);
});

test("parts also keep to the receiver's item limit", async () => {
  const ui = inboxHarness([], { maxBodyBytes: TWO + ONE, maxImportItems: 2, replies: Array(10).fill(importsAll) });
  await importFile(ui, bundle(FIVE));
  assert.deepEqual(sentParts(ui).map((part) => part.feedback.length), [2, 2, 1]);
});

test("comments sharing an id go in one part in file order, so the receiver checks both and keeps the first", async () => {
  const repeated = [comment(9, "2026-10-09T00:00:00.000Z", "first"), ...FIVE, comment(9, "2026-10-09T00:00:00.000Z", "second")];
  const ui = inboxHarness([], { maxBodyBytes: TWO + ONE, replies: Array(10).fill(importsAll) });
  const status = await importFile(ui, bundle(repeated));

  const holding = sentParts(ui).filter((part) => part.feedback.some((item) => item.id === "pl_9"));
  assert.equal(holding.length, 1);
  assert.deepEqual(holding[0].feedback.filter((item) => item.id === "pl_9").map((item) => item.comment), ["first", "second"]);
  assert.equal(status.textContent, "6 件を追加しました。重複 1 件はスキップしました。「受信箱を更新」で一覧に反映します。");
});

test("files that cannot be split are sent as they are: an array, or a number JSON cannot hold", async () => {
  for (const text of [JSON.stringify(FIVE), JSON.stringify(bundle(FIVE)).replace('"schemaVersion":3', '"schemaVersion":1e400')]) {
    const ui = inboxHarness([], { maxBodyBytes: TWO, replies: [{ ok: false, status: 400, body: { ok: false, error: "Import body must be an object" } }] });
    const status = await importFile(ui, text);
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].options.body, text);
    assert.equal(status.textContent, "Import body must be an object");
  }
});

test("a comment over the limit by itself fails alone and the message tells how to raise the limit", async () => {
  const huge = comment(9, "2026-10-09T00:00:00.000Z", "y".repeat(TWO));
  const replies = Array(10).fill((options) => (byteLength(options.body) > TWO ? tooLarge : importsAll(options)));
  const ui = inboxHarness([], { maxBodyBytes: TWO, replies });
  const status = await importFile(ui, bundle([huge, ...FIVE]));

  assert.equal(status.dataset.state, "error");
  assert.equal(status.textContent, `5 件を追加しました。失敗 1 件。コメント 1 件で受信側の上限（${TWO} byte）を超えています。receiver の MAX_BODY_BYTES（設定の maxBodyBytes）を上げると読み込めます。「受信箱を更新」で一覧に反映します。`);
});

test("the size limit guidance shows after a save failure of an earlier part (#157)", async () => {
  const huge = comment(9, "2026-10-09T00:00:00.000Z", "y".repeat(TWO));
  const capacity = { ok: false, status: 507, body: { imported: 0, duplicates: [], failed: [{ id: "pl_1", status: 507, error: "Screenshot storage limit reached" }] } };
  const ui = inboxHarness([], { maxBodyBytes: TWO, maxImportItems: 1, replies: [capacity, importsAll, importsAll, importsAll, importsAll, tooLarge] });
  const status = await importFile(ui, bundle([huge, ...FIVE]));
  assert.equal(status.textContent, `4 件を追加しました。失敗 2 件。受信側の保存容量の上限に達しました。receiver の設定で上限を変更できます。コメント 1 件で受信側の上限（${TWO} byte）を超えています。receiver の MAX_BODY_BYTES（設定の maxBodyBytes）を上げると読み込めます。「受信箱を更新」で一覧に反映します。`);
});

test("a file of one comment over the limit is sent whole and explained", async () => {
  const huge = comment(9, "2026-10-09T00:00:00.000Z", "y".repeat(TWO));
  const ui = inboxHarness([], { maxBodyBytes: TWO, replies: [tooLarge] });
  const status = await importFile(ui, bundle([huge]));
  assert.equal(ui.requests.length, 1);
  assert.equal(status.dataset.state, "error");
  assert.match(status.textContent, /^コメント 1 件で受信側の上限（\d+ byte）を超えています。/);
});

test("an import stopped part way goes on from the part that did not go, when the same file is imported again", async () => {
  const ui = inboxHarness([], { maxBodyBytes: TWO, replies: [importsAll, busy, importsAll, importsAll] });
  const file = bundle(FIVE);
  let status = await importFile(ui, file);
  assert.equal(status.dataset.state, "error");
  assert.match(status.textContent, /^2 件を追加したところで止まりました。リクエストが集中しています。.*同じファイルをもう一度読み込むと、続きから送ります/);
  assert.equal(ui.get("[data-import-reload]").hidden, false);

  status = await importFile(ui, file);
  const bodies = ui.requests.map((request) => request.options.body);
  // Part 2 is sent again, then part 3; part 1 is not.
  assert.equal(bodies.length, 4);
  assert.deepEqual([bodies[2] === bodies[1], bodies.slice(2).includes(bodies[0])], [true, false]);
  assert.equal(status.dataset.state, "success");
  assert.equal(status.textContent, "5 件を追加しました。「受信箱を更新」で一覧に反映します。");
});

test("a stop after a part over the limit still says what failed and why", async () => {
  const huge = comment(9, "2026-09-30T00:00:00.000Z", "y".repeat(TWO));
  const ui = inboxHarness([], { maxBodyBytes: TWO, replies: [tooLarge, busy] });
  const status = await importFile(ui, bundle([...FIVE, huge]));
  assert.equal(ui.requests.length, 2);
  assert.match(status.textContent, new RegExp(`^0 件を追加したところで止まりました。失敗 1 件。コメント 1 件で受信側の上限（${TWO} byte）を超えています。.*リクエストが集中しています。`));
  assert.equal(ui.get("[data-import-reload]").hidden, true);
});
