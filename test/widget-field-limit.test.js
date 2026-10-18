"use strict";

// The comment and the name are held to the receiver's maxFieldLength (#196),
// so a comment the receiver would refuse is told while typing, and is never
// sent or exported.

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.
const COMMENT_TOO_LONG = "コメントが長すぎます。20,000 文字以内にしてください。";
const DOWNLOAD = { persistFeedback: true, deliveryMode: "download" };

function form(w) {
  const document = w.document;
  return {
    form: document.querySelector("[data-pl-comment]"),
    comment: document.querySelector("[data-pl-comment-text]"),
    reviewer: document.querySelector("[data-pl-reviewer]"),
    commentCount: document.querySelector("[data-pl-comment-count]"),
    reviewerCount: document.querySelector("[data-pl-reviewer-count]"),
    error: document.querySelector("[data-pl-form-error]")
  };
}

function type(field, value) {
  field.value = value;
  field.emit("input");
}

const confirm = async (w) => Promise.all(form(w).form.emit("submit"));
const shownError = (w) => (form(w).error.hidden ? "" : form(w).error.textContent);
const notice = (w) => w.document.querySelector("[data-pl-notice]");
const listItem = (w, comment) => w.document.querySelectorAll("[data-feedback-id]")
  .find((node) => node.dataset.feedbackId === w.api.getFeedback().find((item) => item.comment === comment).id);
const bundleAt = async (w, index) => JSON.parse(await w.downloads[index].blob.text());
const NOT_SENT_10 = "コメントか投稿者名が長すぎるため、送っていません。編集で 10 文字以内にしてから再送してください。";

async function submitAs(w, comment, reviewer) {
  w.capture();
  form(w).comment.value = comment;
  form(w).reviewer.value = reviewer;
  await confirm(w);
}

const retryOf = (w) => Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: w.document.querySelector("[data-pl-retry]") }));

test("a comment longer than the receiver takes is told while typing and cannot be confirmed (#196)", async () => {
  const w = widgetHarness();
  w.init();
  w.capture();
  const f = form(w);
  type(f.comment, "a".repeat(20_000));
  assert.equal(shownError(w), "");
  assert.equal(f.commentCount.hidden, true);

  type(f.comment, `${"a".repeat(20_000)}b`);
  assert.equal(shownError(w), COMMENT_TOO_LONG);
  assert.equal(f.commentCount.hidden, false);
  assert.equal(f.commentCount.textContent, "20,001 / 20,000 文字");
  assert.equal(f.comment.getAttribute("aria-invalid"), "true");
  assert.deepEqual(f.comment.getAttribute("aria-describedby").split(" "), ["pl-form-error", "pl-comment-count", "pl-uncaptured-hint"]);
  assert.equal(f.commentCount.getAttribute("id"), "pl-comment-count");
  assert.equal(f.comment.closest("label").contains(f.commentCount), false, "the count is not part of the field's name");

  await confirm(w);
  assert.equal(w.api.getFeedback().length, 0, "not listed");
  assert.equal(w.requests.length, 0, "not sent");
  assert.equal(f.form.hidden, false);
  assert.ok(w.document.activeElement === f.comment, "focus goes to the comment");

  // The spaces around it are not saved, so they do not count.
  type(f.comment, `  ${"a".repeat(20_000)}\n`);
  assert.equal(shownError(w), "");
  assert.equal(f.commentCount.hidden, true);
  assert.equal(f.comment.getAttribute("aria-invalid"), null);
  await confirm(w);
  assert.equal(w.api.getFeedback()[0].comment.length, 20_000);
  assert.equal(w.requests.length, 1);
});

test("the alert is set once while the comment stays too long, and the count follows the typing (#196)", () => {
  const w = widgetHarness();
  w.init();
  w.capture();
  const f = form(w);
  let sets = 0;
  let text = f.error.textContent;
  Object.defineProperty(f.error, "textContent", { get: () => text, set(value) { sets += 1; text = value; }, configurable: true });

  type(f.comment, "a".repeat(20_001));
  assert.equal(sets, 1);
  type(f.comment, "a".repeat(20_002));
  type(f.comment, "a".repeat(20_005));
  assert.equal(sets, 1, "not set again, so not read out again");
  assert.equal(f.commentCount.textContent, "20,005 / 20,000 文字");

  type(f.comment, "a".repeat(19_999));
  assert.equal(shownError(w), "");
  // An error of another kind still clears on typing, as before.
  type(f.comment, "");
  type(f.reviewer, "");
  f.form.emit("submit");
  assert.equal(shownError(w), "コメントを入力してください。");
  type(f.reviewer, "Reviewer");
  assert.equal(shownError(w), "");
});

test("a name longer than the receiver takes is told the same way and is not saved (#196)", async () => {
  const storage = new Map();
  const w = widgetHarness({ storage });
  w.init();
  w.capture();
  const f = form(w);
  type(f.comment, "On the item");
  type(f.reviewer, "n".repeat(20_001));
  assert.equal(shownError(w), "投稿者名が長すぎます。20,000 文字以内にしてください。");
  assert.equal(f.reviewerCount.hidden, false);
  assert.equal(f.reviewerCount.textContent, "20,001 / 20,000 文字");
  assert.equal(f.reviewer.getAttribute("aria-invalid"), "true");
  assert.deepEqual(f.reviewer.getAttribute("aria-describedby").split(" "), ["pl-form-error", "pl-reviewer-count"]);
  await confirm(w);
  assert.equal(w.api.getFeedback().length, 0);
  assert.ok(w.document.activeElement === f.reviewer, "focus goes to the name");
  assert.equal(storage.has("patchloop:reviewer"), false, "the name is not saved");

  // Both too long: the comment is told first.
  type(f.comment, "c".repeat(20_001));
  assert.equal(shownError(w), COMMENT_TOO_LONG);
  assert.equal(f.reviewerCount.hidden, false, "the name still shows its count");
});

test("maxFieldLength changes the limit, and a value that is not a positive integer keeps the default (#196)", async () => {
  const w = widgetHarness();
  w.init({ maxFieldLength: 10 });
  w.capture();
  type(form(w).comment, "a".repeat(11));
  assert.equal(shownError(w), "コメントが長すぎます。10 文字以内にしてください。");
  assert.equal(form(w).commentCount.textContent, "11 / 10 文字");
  await confirm(w);
  assert.equal(w.api.getFeedback().length, 0);
  type(form(w).comment, "a".repeat(10));
  await confirm(w);
  assert.equal(w.api.getFeedback().length, 1);

  for (const value of [0, -1, 1.5, "100", null, Number.POSITIVE_INFINITY]) {
    const other = widgetHarness();
    other.init({ maxFieldLength: value });
    assert.ok(other.warnings.some(([message]) => String(message).includes("maxFieldLength must be a positive integer")), `warned for ${String(value)}`);
    other.capture();
    type(form(other).comment, "a".repeat(20_001));
    assert.equal(shownError(other), COMMENT_TOO_LONG, `the default for ${String(value)}`);
  }
  const unset = widgetHarness();
  unset.init();
  assert.equal(unset.warnings.length, 0);
});

test("an edit is held to the limit, and a saved comment past a lowered limit says so when opened (#196)", async () => {
  const storage = new Map();
  const before = widgetHarness({ storage });
  before.init(DOWNLOAD);
  await before.submit("a".repeat(20));
  await before.submit("Short");
  before.api.destroy();

  const w = widgetHarness({ storage });
  w.init({ ...DOWNLOAD, maxFieldLength: 10 });
  listItem(w, "a".repeat(20)).querySelector("[data-pl-edit]").click();
  assert.equal(shownError(w), "コメントが長すぎます。10 文字以内にしてください。");
  assert.equal(form(w).commentCount.textContent, "20 / 10 文字");
  type(form(w).comment, "Shortened");
  assert.equal(shownError(w), "");
  await confirm(w);
  assert.ok(w.api.getFeedback().some((item) => item.comment === "Shortened"));

  listItem(w, "Short").querySelector("[data-pl-edit]").click();
  assert.equal(shownError(w), "");
  assert.equal(form(w).commentCount.hidden, true);
  type(form(w).comment, "a".repeat(11));
  await confirm(w);
  assert.equal(form(w).form.hidden, false, "the edit is not saved");
  assert.ok(w.api.getFeedback().some((item) => item.comment === "Short"));
});

test("an export leaves out the comments past the limit and says how many, and none at all when every one is (#196)", async () => {
  const storage = new Map();
  const before = widgetHarness({ storage });
  before.init(DOWNLOAD);
  await before.submit("a".repeat(20));
  await before.submit("Fits");
  before.api.destroy();

  const w = widgetHarness({ storage });
  w.init({ ...DOWNLOAD, maxFieldLength: 10 });
  w.document.querySelector("[data-pl-download-all]").click();
  assert.equal(w.downloads.length, 1);
  const bundle = await bundleAt(w, 0);
  assert.deepEqual(bundle.feedback.map((item) => item.comment), ["Fits"]);
  assert.match(w.downloads[0].name, /-1-/, "the file name counts what it holds");
  assert.equal(notice(w).textContent, "ファイルの保存を開始しました。保存できなかった場合は「全件を再ダウンロード」を使ってください。1 件は、コメントか投稿者名が 10 文字を超えているため書き出していません。編集で短くしてから書き出してください。");
  assert.equal(notice(w).dataset.state, "error");
  const exported = Object.fromEntries(w.api.getFeedback().map((item) => [item.comment.slice(0, 4), Boolean(item.exported)]));
  assert.deepEqual(exported, { aaaa: false, Fits: true });

  // Only the long one is left: nothing to write out.
  w.document.querySelector("[data-pl-download-all]").click();
  assert.equal(w.downloads.length, 1);
  assert.equal(notice(w).textContent, "コメントか投稿者名が 10 文字を超えているため、書き出せません。編集で短くしてください。");
  assert.equal(notice(w).dataset.state, "error");

  // Writing out every one again leaves it out too.
  w.document.querySelector("[data-pl-download-again]").click();
  assert.equal(w.downloads.length, 2);
  assert.deepEqual((await bundleAt(w, 1)).feedback.map((item) => item.comment), ["Fits"]);
});

test("a saved comment past the limit is not resent until it is shortened (#196)", async () => {
  const storage = new Map();
  const before = widgetHarness({ storage, replies: [new Error("network")] });
  before.init({ persistFeedback: true });
  await before.submit("a".repeat(20));
  assert.equal(before.api.getFeedback()[0].delivery.ok, false);
  before.api.destroy();

  const w = widgetHarness({ storage });
  w.init({ persistFeedback: true, maxFieldLength: 10 });
  await retryOf(w);
  assert.equal(w.requests.length, 0);
  assert.equal(notice(w).textContent, NOT_SENT_10);
  assert.equal(notice(w).dataset.state, "error");
  assert.deepEqual([w.api.getFeedback()[0].delivery.ok, w.api.getFeedback()[0].delivery.tooLong], [false, undefined], "its last delivery is kept");

  listItem(w, "a".repeat(20)).querySelector("[data-pl-edit]").click();
  type(form(w).comment, "Shortened");
  await confirm(w);
  await retryOf(w);
  assert.equal(w.requests.length, 1);
  assert.equal(JSON.parse(w.requests[0].body).comment, "Shortened");
});

test("a resend held back by the limit keeps a cut-off delivery, so the shortened edit still goes as a revision (#121, #196)", async () => {
  const w = widgetHarness({ replies: [() => new Promise(() => {})] });
  w.init({ persistFeedback: true });
  w.submit("a".repeat(20));
  w.api.destroy();
  w.init({ persistFeedback: true, maxFieldLength: 10 });
  const originalId = w.api.getFeedback()[0].id;
  assert.equal(w.api.getFeedback()[0].delivery.interrupted, true);

  await retryOf(w);
  assert.equal(w.requests.length, 1, "not sent again");
  assert.equal(notice(w).textContent, NOT_SENT_10);
  assert.equal(w.api.getFeedback()[0].delivery.interrupted, true, "the receiver may still hold it");

  listItem(w, "a".repeat(20)).querySelector("[data-pl-edit]").click();
  type(form(w).comment, "Shortened");
  await confirm(w);
  assert.equal(w.requests.length, 2);
  const sent = JSON.parse(w.requests[1].body);
  assert.deepEqual([sent.comment, sent.replaces, sent.id === originalId], ["Shortened", originalId, false]);
});

test("a saved comment whose name alone is past the limit is neither resent nor exported (#196)", async () => {
  const storage = new Map();
  const failed = widgetHarness({ storage, replies: [new Error("network")] });
  failed.init({ persistFeedback: true });
  await submitAs(failed, "Short", "n".repeat(20));
  assert.equal(failed.api.getFeedback()[0].delivery.ok, false);
  failed.api.destroy();
  const w = widgetHarness({ storage });
  w.init({ persistFeedback: true, maxFieldLength: 10 });
  await retryOf(w);
  assert.equal(w.requests.length, 0);
  assert.equal(notice(w).textContent, NOT_SENT_10);

  const downloadStorage = new Map();
  const before = widgetHarness({ storage: downloadStorage });
  before.init(DOWNLOAD);
  await submitAs(before, "Long name", "n".repeat(20));
  await submitAs(before, "Fits", "Rev");
  before.api.destroy();
  const exporting = widgetHarness({ storage: downloadStorage });
  exporting.init({ ...DOWNLOAD, maxFieldLength: 10 });
  exporting.document.querySelector("[data-pl-download-all]").click();
  assert.deepEqual((await bundleAt(exporting, 0)).feedback.map((item) => item.comment), ["Fits"]);
  const exported = Object.fromEntries(exporting.api.getFeedback().map((item) => [item.comment, Boolean(item.exported)]));
  assert.deepEqual(exported, { "Long name": false, Fits: true });
});

test("a comment changed past the limit by onSubmit or a patchloop:feedback listener is not sent (#196)", async () => {
  const w = widgetHarness();
  w.init({ maxFieldLength: 10, onSubmit: (payload) => { payload.comment += "!"; } });
  await w.submit("a".repeat(10));
  assert.equal(w.requests.length, 0);
  assert.equal(w.api.getFeedback()[0].delivery.tooLong, true);
  assert.equal(notice(w).textContent, NOT_SENT_10);
  assert.equal(notice(w).dataset.state, "error");
  assert.equal(w.document.querySelector(".pl-feedback-status-fail").getAttribute("title"), NOT_SENT_10, "the list says why");

  const listened = widgetHarness();
  listened.init({ maxFieldLength: 10 });
  listened.document.addEventListener("patchloop:feedback", (event) => { event.detail.reviewer = "n".repeat(11); });
  await listened.submit("Fits");
  assert.equal(listened.requests.length, 0);
  assert.equal(notice(listened).textContent, NOT_SENT_10);
});
