"use strict";

// A comment edited after it left this device (exported, or the receiver may
// hold it) goes as a revision (#121): a new comment that replaces the original
// in the list and points at it with replaces, so an import does not skip the
// edit as a duplicate and nothing the receiver holds is rewritten.

const assert = require("node:assert/strict");
const test = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { widgetHarness } = require("../test-support/widget-dom.js");

const DOWNLOAD = { persistFeedback: true, deliveryMode: "download" };
const listItem = (w, comment) => w.document.querySelectorAll("[data-feedback-id]")
  .find((node) => node.dataset.feedbackId === w.api.getFeedback().find((item) => item.comment === comment).id);
const exportAll = (w) => w.document.querySelector("[data-pl-download-all]").click();
const bundleAt = async (w, index) => JSON.parse(await w.downloads[index].blob.text());
const notice = (w) => w.document.querySelector("[data-pl-notice]").textContent;
// Built in this realm: the widget's arrays come from the vm's.
const pins = (w) => Array.from(w.document.querySelectorAll("[data-patchloop-pin]"), (pin) => [pin.dataset.patchloopFeedbackId, pin.textContent]);

async function edit(w, from, to) {
  listItem(w, from).querySelector("[data-pl-edit]").click();
  await w.submit(to, { captureTarget: false });
}

test("an edit after the export goes into the next export as a revision of the exported comment", async () => {
  const w = widgetHarness();
  w.init(DOWNLOAD);
  await w.submit("First");
  await sleep(2);
  await w.submit("Second");
  exportAll(w);
  const [second, first] = Array.from(w.api.getFeedback(), (item) => item.id);

  await edit(w, "First", "First, corrected");
  assert.equal(notice(w), "変更を元のコメントの修正版として保存しました。「未送信を書き出す」から共有できます。");
  assert.deepEqual(Array.from(w.api.getFeedback(), (item) => [item.comment, item.replaces ?? null]), [["Second", null], ["First, corrected", first]]);
  const revision = w.api.getFeedback()[1];
  assert.deepEqual(pins(w).sort((a, b) => a[1].localeCompare(b[1])), [[revision.id, "1"], [second, "2"]]);
  assert.equal(w.document.querySelector("[data-pl-download-all]").textContent, "未送信を書き出す（1）");

  exportAll(w);
  const bundle = await bundleAt(w, 1);
  assert.deepEqual(Array.from(bundle.feedback, (item) => [item.id, item.comment, item.replaces, item.schemaVersion]), [[revision.id, "First, corrected", first, 4]]);
  assert.equal(bundle.feedback[0].createdAt, (await bundleAt(w, 0)).feedback[1].createdAt);
});

test("a revision edited again after its own export points at the revision", async () => {
  const w = widgetHarness();
  w.init(DOWNLOAD);
  await w.submit("v1");
  exportAll(w);
  await edit(w, "v1", "v2");
  const v2 = w.api.getFeedback()[0].id;
  exportAll(w);
  await edit(w, "v2", "v3");
  assert.deepEqual([w.api.getFeedback().length, w.api.getFeedback()[0].replaces], [1, v2]);
});

test("an edit that changes nothing after the export makes no revision", async () => {
  const w = widgetHarness();
  w.init(DOWNLOAD);
  await w.submit("Same");
  exportAll(w);
  const id = w.api.getFeedback()[0].id;
  await edit(w, "Same", "Same");
  assert.equal(notice(w), "変更はありません。");
  assert.deepEqual([w.api.getFeedback()[0].id, w.api.getFeedback()[0].exported], [id, true]);
});

test("a comment with a local change from before revisions is sent as a revision when saved, even unchanged", async () => {
  const w = widgetHarness();
  w.init({ persistFeedback: true });
  await w.submit("Changed before #121");
  const original = w.api.getFeedback()[0];
  original.localEdited = true;
  await edit(w, "Changed before #121", "Changed before #121");
  assert.equal(w.requests.length, 2);
  const revision = JSON.parse(w.requests[1].body);
  assert.deepEqual([revision.comment, revision.replaces, revision.localEdited], ["Changed before #121", original.id, undefined]);
  assert.equal(w.api.getFeedback()[0].delivery.ok, true);
});

test("a revision is announced like a new comment (patchloop:feedback and onSubmit)", async () => {
  const w = widgetHarness();
  const submitted = [];
  const announced = [];
  w.document.addEventListener("patchloop:feedback", (event) => announced.push(event.detail.comment));
  w.init({ persistFeedback: true, onSubmit: (payload) => submitted.push([payload.comment, payload.replaces ?? null]) });
  await w.submit("Original");
  await edit(w, "Original", "Revised");
  assert.deepEqual(announced, ["Original", "Revised"]);
  assert.deepEqual(submitted.map(([comment, replaces]) => [comment, Boolean(replaces)]), [["Original", false], ["Revised", true]]);
});

test("another tab takes the revision's place for the original when it hears of it", async () => {
  const storage = new Map();
  const a = widgetHarness({ storage });
  a.init(DOWNLOAD);
  await a.submit("Shared");
  exportAll(a);
  const b = widgetHarness({ storage });
  b.init(DOWNLOAD);
  await edit(a, "Shared", "Shared, corrected");
  const key = [...storage.keys()].find((name) => name.startsWith("patchloop:feedback:"));
  b.window.emit("storage", { key });
  assert.deepEqual(Array.from(b.api.getFeedback(), (item) => [item.comment, Boolean(item.replaces)]), [["Shared, corrected", true]]);
  assert.equal(pins(b).length, 1);
  assert.equal(pins(b)[0][0], b.api.getFeedback()[0].id);
});
