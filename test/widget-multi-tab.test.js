"use strict";

// Tabs of the same page share one saved list (#139): each save merges what
// another tab saved, and a save in another tab is taken in as it happens, so
// no tab overwrites another tab's comments.

const assert = require("node:assert/strict");
const test = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { widgetHarness } = require("../test-support/widget-dom.js");
const { feedbackFingerprints, mergeFeedbackLists } = require("../widget/src/tab-sync.js");

const BASE = "https://demo.example";
const DOWNLOAD = { persistFeedback: true, deliveryMode: "download" };

function openTab(storage, { path = "/page", options = DOWNLOAD, harness = {} } = {}) {
  const w = widgetHarness({ storage, ...harness });
  w.window.location.href = `${BASE}${path}`;
  w.init(options);
  return w;
}

const keyOf = (storage, path = "/page") => [...storage.keys()].find((key) => key.endsWith(`${JSON.stringify(`${BASE}${path}`)}]`));
// What the browser does in the other tabs when a tab writes the key.
const hear = (w, key) => w.window.emit("storage", { key });
// Built in this realm: the widget's arrays come from the vm's.
const comments = (w) => Array.from(w.api.getFeedback(), (item) => item.comment);
const saved = (storage, path) => JSON.parse(storage.get(keyOf(storage, path))).feedback;
const savedComments = (storage, path) => saved(storage, path).map((item) => item.comment);
const listItem = (w, comment) => w.document.querySelectorAll("[data-feedback-id]")
  .find((node) => node.dataset.feedbackId === w.api.getFeedback().find((item) => item.comment === comment).id);
// { comment: marker number } of the pins on the page.
function markers(w) {
  const byId = new Map(w.api.getFeedback().map((item) => [item.id, item.comment]));
  return Object.fromEntries(w.document.querySelectorAll("[data-patchloop-pin]").map((pin) => [byId.get(pin.dataset.patchloopFeedbackId) ?? "?", pin.textContent]));
}
const listOf = (w) => w.document.querySelector("[data-pl-list]");
const noticeOf = (w) => w.document.querySelector("[data-pl-notice]").textContent;
const formHidden = (w) => w.document.querySelector("[data-pl-comment]").hidden;

// Comments made a moment apart, so their dates order them.
async function add(w, comment) {
  await sleep(2);
  await w.submit(comment);
}

test("comments added in two tabs are all kept, even when a tab saves before hearing of the other's", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "A1");
  const b = openTab(storage);
  await add(b, "B1");
  await add(a, "A2");

  assert.deepEqual(savedComments(storage), ["A2", "B1", "A1"]);
  assert.deepEqual(comments(a), ["A2", "B1", "A1"]);
  assert.deepEqual(markers(a), { A1: "1", B1: "2", A2: "3" });
  assert.deepEqual(comments(openTab(storage)), ["A2", "B1", "A1"]);
});

test("a tab takes in what another tab saves as it happens: new comments with their markers, and edits", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "A1");
  const b = openTab(storage);
  await add(b, "B1");

  hear(a, keyOf(storage));
  assert.deepEqual(comments(a), ["B1", "A1"]);
  assert.deepEqual(markers(a), { A1: "1", B1: "2" });
  assert.match(listOf(a).innerHTML, /B1/);

  listItem(b, "A1").querySelector("[data-pl-edit]").click();
  await b.submit("A1 edited in B", { captureTarget: false });
  hear(a, keyOf(storage));
  assert.deepEqual(comments(a), ["B1", "A1 edited in B"]);
  assert.match(a.document.querySelector("[data-patchloop-pin]").getAttribute("aria-label"), /A1 edited in B/);

  // The last save wins.
  listItem(a, "A1 edited in B").querySelector("[data-pl-edit]").click();
  await a.submit("A1 edited in A", { captureTarget: false });
  hear(b, keyOf(storage));
  assert.deepEqual(savedComments(storage), ["B1", "A1 edited in A"]);
  assert.deepEqual(comments(b), ["B1", "A1 edited in A"]);
});

test("a save takes in another tab's edit of a comment this tab did not change, marker label included", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "A1");
  const b = openTab(storage);
  listItem(b, "A1").querySelector("[data-pl-edit]").click();
  await b.submit("A1 edited in B", { captureTarget: false });

  await add(a, "A2");
  assert.deepEqual(savedComments(storage), ["A2", "A1 edited in B"]);
  assert.deepEqual(comments(a), ["A2", "A1 edited in B"]);
  const pin = a.document.querySelectorAll("[data-patchloop-pin]").find((node) => node.textContent === "1");
  assert.match(pin.getAttribute("aria-label"), /A1 edited in B/);
});

test("a comment deleted in one tab stays deleted when another tab saves before hearing of it", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "Keep");
  await add(a, "Drop");
  const b = openTab(storage);

  listItem(a, "Drop").querySelector("[data-pl-delete]").click();
  await add(b, "B1");

  assert.deepEqual(savedComments(storage), ["B1", "Keep"]);
  assert.deepEqual(comments(b), ["B1", "Keep"]);
  assert.deepEqual(markers(b), { Keep: "1", B1: "2" });
});

test("a deletion in another tab closes the edit of that comment, whether heard first or met on saving", async () => {
  for (const heardFirst of [true, false]) {
    const storage = new Map();
    const a = openTab(storage);
    await add(a, "Keep");
    await add(a, "Drop");
    const b = openTab(storage);
    listItem(b, "Drop").querySelector("[data-pl-edit]").click();
    assert.equal(formHidden(b), false);

    listItem(a, "Drop").querySelector("[data-pl-delete]").click();
    if (heardFirst) hear(b, keyOf(storage));
    else await b.submit("Edited after the deletion", { captureTarget: false });

    assert.equal(formHidden(b), true);
    assert.equal(noticeOf(b), "このコメントは別のタブで削除されました。");
    assert.deepEqual(comments(b), ["Keep"]);
    assert.deepEqual(savedComments(storage), ["Keep"]);
  }
});

test("clearing the page's comments in one tab clears them in the others", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "One");
  await add(a, "Two");
  const b = openTab(storage);
  const key = keyOf(storage);

  a.document.querySelector("[data-pl-clear]").click();
  hear(b, key);
  assert.deepEqual(comments(b), []);
  assert.deepEqual(markers(b), {});

  await add(b, "After");
  assert.deepEqual(savedComments(storage), ["After"]);
});

test("export marks set from another page's tab survive a save of this page's tab that had not heard of them", async () => {
  const storage = new Map();
  const onB = openTab(storage, { path: "/b" });
  await add(onB, "On B");
  const onA = openTab(storage, { path: "/a" });
  await add(onA, "On A");

  onA.document.querySelector("[data-pl-download-all]").click();
  assert.equal(saved(storage, "/b")[0].exported, true);

  await add(onB, "On B later");
  assert.deepEqual(saved(storage, "/b").map((item) => [item.comment, Boolean(item.exported)]), [["On B later", false], ["On B", true]]);
  assert.equal(onB.api.getFeedback()[1].exported, true);
});

test("an edit after the export is not marked again by another tab's older copy", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "Draft");
  const b = openTab(storage);
  a.document.querySelector("[data-pl-download-all]").click();
  hear(b, keyOf(storage));
  assert.equal(b.api.getFeedback()[0].exported, true);

  listItem(a, "Draft").querySelector("[data-pl-edit]").click();
  await a.submit("Draft, corrected", { captureTarget: false });
  await add(b, "B1");
  assert.deepEqual(saved(storage).map((item) => [item.comment, Boolean(item.exported)]), [["B1", false], ["Draft, corrected", false]]);
});

test("an export takes in an edit another tab saved and this tab had not heard of, and marks that text", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "Draft");
  const b = openTab(storage);
  listItem(b, "Draft").querySelector("[data-pl-edit]").click();
  await b.submit("Draft, edited in B", { captureTarget: false });

  a.document.querySelector("[data-pl-download-all]").click();
  const bundle = JSON.parse(await a.downloads[0].blob.text());
  assert.deepEqual(Array.from(bundle.feedback, (item) => item.comment), ["Draft, edited in B"]);
  assert.deepEqual(saved(storage).map((item) => [item.comment, Boolean(item.exported)]), [["Draft, edited in B", true]]);
});

test("a delivery another tab is making shows as in progress and its result reaches both tabs", async () => {
  const storage = new Map();
  let complete;
  const a = openTab(storage, { options: { persistFeedback: true }, harness: { replies: [() => new Promise((resolve) => { complete = resolve; })] } });
  const submission = a.submit("Sending");
  const b = openTab(storage, { options: { persistFeedback: true } });

  assert.equal(b.api.getFeedback()[0].delivery.pending, true);
  assert.equal(b.document.querySelector("[data-pl-retry]"), null);
  assert.match(listOf(b).innerHTML, /送信中…/);

  // B saves meanwhile; A hears of it but keeps its own delivery state.
  await add(b, "B meanwhile");
  hear(a, keyOf(storage));
  assert.equal(a.api.getFeedback().find((item) => item.comment === "Sending").delivery.pending, true);

  complete({ ok: true, status: 201 });
  await submission;
  assert.equal(saved(storage).find((item) => item.comment === "Sending").delivery.ok, true);
  assert.deepEqual(savedComments(storage), ["B meanwhile", "Sending"]);
  hear(b, keyOf(storage));
  assert.equal(b.api.getFeedback().find((item) => item.comment === "Sending").delivery.ok, true);
});

test("a delivery of a tab that stopped without a word (crashed) becomes interrupted once it would have timed out", async () => {
  const storage = new Map();
  const a = openTab(storage, { options: { persistFeedback: true }, harness: { replies: [() => new Promise(() => {})] } });
  a.submit("Cut off");

  const scheduled = [];
  const timers = { setTimeout: (callback, ms) => scheduled.push({ callback, ms }), clearTimeout() {} };
  const b = openTab(storage, { options: { persistFeedback: true }, harness: { timers } });
  assert.equal(b.api.getFeedback()[0].delivery.pending, true);
  const check = scheduled.find((timer) => timer.ms > 15000 && timer.ms <= 20000);
  assert.ok(check);

  // Fired early, it waits again; fired when the time is over, it settles.
  check.callback();
  assert.equal(b.api.getFeedback()[0].delivery.pending, true);
  b.api.getFeedback()[0].delivery.startedAt -= 20000;
  scheduled.at(-1).callback();
  assert.equal(b.api.getFeedback()[0].delivery.interrupted, true);
  assert.equal(saved(storage)[0].delivery.interrupted, true);
  assert.ok(b.document.querySelector("[data-pl-retry]"));
});

test("a pending delivery saved without its start time is taken as cut off, as before", () => {
  const storage = new Map();
  storage.set(`patchloop:feedback:${JSON.stringify(["local-demo", "plain-html", `${BASE}/page`])}`, JSON.stringify({
    version: 1, projectId: "local-demo", demoId: "plain-html", pageUrl: `${BASE}/page`, savedAt: "2026-01-01T00:00:00.000Z",
    feedback: [{ id: "pl_old", comment: "Old", target: { kind: "point", pageX: 10, pageY: 10 }, delivery: { pending: true, target: "receiver" } }]
  }));
  const b = openTab(storage, { options: { persistFeedback: true } });
  assert.equal(b.api.getFeedback()[0].delivery.interrupted, true);
});

test("a tab closed or reloaded mid-delivery saves it as interrupted, so other tabs and the next load offer the retry at once", async () => {
  const storage = new Map();
  const a = openTab(storage, { options: { persistFeedback: true }, harness: { replies: [() => new Promise(() => {})] } });
  a.submit("Sending at reload");
  const b = openTab(storage, { options: { persistFeedback: true } });
  assert.equal(b.api.getFeedback()[0].delivery.pending, true);

  a.window.emit("pagehide");
  assert.equal(saved(storage)[0].delivery.interrupted, true);
  hear(b, keyOf(storage));
  assert.equal(b.api.getFeedback()[0].delivery.interrupted, true);
  assert.ok(b.document.querySelector("[data-pl-retry]"));
  const reloaded = openTab(storage, { options: { persistFeedback: true } });
  assert.equal(reloaded.api.getFeedback()[0].delivery.interrupted, true);
});

test("the tooltip of a focused marker follows another tab's edit and closes when the comment is deleted there", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "Before");
  const b = openTab(storage);
  a.document.querySelector("[data-patchloop-pin]").focus();
  const tooltip = a.document.querySelector("[data-pl-tooltip]");
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.textContent, /Before/);

  listItem(b, "Before").querySelector("[data-pl-edit]").click();
  await b.submit("After", { captureTarget: false });
  hear(a, keyOf(storage));
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.textContent, /After/);

  listItem(b, "After").querySelector("[data-pl-delete]").click();
  hear(a, keyOf(storage));
  assert.equal(tooltip.hidden, true);
});

test("an edit this tab could not save survives taking in other tabs' saves, and goes into the export", async () => {
  const storage = new Map();
  const a = openTab(storage);
  await add(a, "Before");
  const key = keyOf(storage);
  const setItem = a.window.localStorage.setItem;
  a.window.localStorage.setItem = (name, value) => {
    if (name === key) throw new Error("QuotaExceededError");
    return setItem(name, value);
  };
  listItem(a, "Before").querySelector("[data-pl-edit]").click();
  await a.submit("After, not saved", { captureTarget: false });
  assert.deepEqual(savedComments(storage), ["Before"]);
  a.window.localStorage.setItem = setItem;

  a.document.querySelector("[data-pl-download-all]").click();
  const bundle = JSON.parse(await a.downloads[0].blob.text());
  assert.deepEqual(Array.from(bundle.feedback, (item) => item.comment), ["After, not saved"]);
  assert.deepEqual(savedComments(storage), ["After, not saved"]);
});

test("an edit another tab saves while this tab's delivery is on its way is a local change once it is delivered", async () => {
  const storage = new Map();
  let complete;
  const replies = [{ ok: false, status: 500 }, () => new Promise((resolve) => { complete = resolve; })];
  const a = openTab(storage, { options: { persistFeedback: true }, harness: { replies } });
  await add(a, "As sent");
  const b = openTab(storage, { options: { persistFeedback: true } });
  listItem(b, "As sent").querySelector("[data-pl-edit]").click();

  const retry = a.document.querySelector("[data-pl-retry]");
  const retrying = Promise.all(listOf(a).emit("click", { target: retry }));
  hear(b, keyOf(storage));
  await b.submit("Edited in B", { captureTarget: false });
  hear(a, keyOf(storage));
  complete({ ok: true, status: 201 });
  await retrying;

  assert.equal(JSON.parse(a.requests[1].body).comment, "As sent");
  const [stored] = saved(storage);
  assert.deepEqual([stored.comment, stored.delivery.ok, stored.localEdited], ["Edited in B", true, true]);
  assert.match(listOf(a).innerHTML, /ローカル変更・送信先には未反映/);
});

test("a delivery given up at pagehide does not report back later over another tab's retry", async () => {
  const storage = new Map();
  let fail;
  const a = openTab(storage, { options: { persistFeedback: true }, harness: { replies: [() => new Promise((resolve) => { fail = resolve; })] } });
  const submission = a.submit("Sent before pagehide");
  a.window.emit("pagehide");
  const b = openTab(storage, { options: { persistFeedback: true } });
  await Promise.all(listOf(b).emit("click", { target: b.document.querySelector("[data-pl-retry]") }));
  assert.equal(saved(storage)[0].delivery.ok, true);

  // The page comes back (back/forward cache) and its first request fails late.
  fail({ ok: false, status: 500 });
  await submission;
  assert.equal(saved(storage)[0].delivery.ok, true);
});

test("the timed-out check reads the saved list first, so a result whose storage event is late is not undone", async () => {
  const storage = new Map();
  let complete;
  const a = openTab(storage, { options: { persistFeedback: true }, harness: { replies: [() => new Promise((resolve) => { complete = resolve; })] } });
  const submission = a.submit("Slow");
  const scheduled = [];
  const timers = { setTimeout: (callback, ms) => scheduled.push({ callback, ms }), clearTimeout() {} };
  const b = openTab(storage, { options: { persistFeedback: true }, harness: { timers } });
  complete({ ok: true, status: 201 });
  await submission;

  // B has not heard of the result when its check runs.
  b.api.getFeedback()[0].delivery.startedAt -= 20000;
  scheduled.find((timer) => timer.ms > 15000 && timer.ms <= 20000).callback();
  assert.equal(b.api.getFeedback()[0].delivery.ok, true);
  assert.equal(saved(storage)[0].delivery.ok, true);
});

// --- mergeFeedbackLists --------------------------------------------------

const item = (id, createdAt, extra = {}) => ({ id, createdAt, comment: id, reviewer: "R", ...extra });
// What this tab last read or wrote.
const knownAs = (...items) => new Map(items.map((entry) => [entry.id, feedbackFingerprints(entry)]));

test("merge on save: a comment changed here keeps this tab's version, one not changed here takes the stored one", () => {
  const changedHere = item("changed-here", "2026-01-04", { comment: "ours" });
  const copyOnly = item("copy-only", "2026-01-03");
  const ours = [item("new", "2026-01-06"), changedHere, copyOnly, item("gone", "2026-01-02")];
  const stored = [item("theirs", "2026-01-05"), item("changed-here", "2026-01-04", { comment: "stored" }), item("copy-only", "2026-01-03", { comment: "edited there" }), item("deleted-here", "2026-01-01")];
  const known = knownAs(item("changed-here", "2026-01-04"), copyOnly, item("gone", "2026-01-02"), item("deleted-here", "2026-01-01"));
  const { list, added, removed } = mergeFeedbackLists(ours, stored, known, { prefer: "ours" });
  assert.deepEqual(list.map((entry) => entry.id), ["new", "theirs", "changed-here", "copy-only"]);
  assert.equal(list[2], changedHere);
  assert.equal(changedHere.comment, "ours");
  assert.equal(list[3], copyOnly);
  assert.equal(copyOnly.comment, "edited there");
  assert.deepEqual(added.map((entry) => entry.id), ["theirs"]);
  assert.deepEqual(removed, ["gone"]);
});

test("merge on save takes part by part: this tab's marks or delivery do not carry its old text over another tab's edit", () => {
  const before = item("a", "2026-01-01", { comment: "old" });
  const exportedHere = { ...before, exported: true, exportedAt: "t", exportedFileName: "f.json" };
  const deliveredHere = { ...before, delivery: { ok: true, status: 201 } };
  for (const ours of [exportedHere, deliveredHere]) {
    const stored = [{ ...before, comment: "edited there", localEdited: true }];
    const { list } = mergeFeedbackLists([ours], stored, knownAs(before), { prefer: "ours" });
    assert.equal(list[0].comment, "edited there");
    assert.equal(list[0].localEdited, true);
    // The export was of the old text, so the edit is not marked as exported.
    assert.equal(list[0].exported, undefined);
    assert.deepEqual(list[0].delivery, ours.delivery);
  }
});

test("merge on hearing another tab: its version wins in place, except a delivery this tab is making", () => {
  const sending = item("sending", "2026-01-02", { delivery: { pending: true } });
  const edited = item("edited", "2026-01-01", { exported: true, exportedAt: "x" });
  const ours = [item("unsaved", "2026-01-03"), sending, edited];
  const stored = [item("sending", "2026-01-02", { delivery: { ok: null, interrupted: true } }), item("edited", "2026-01-01", { comment: "changed there" })];
  const { list } = mergeFeedbackLists(ours, stored, knownAs(sending, edited), { prefer: "stored", keepDelivery: new Set(["sending"]) });
  assert.deepEqual(list.map((entry) => entry.id), ["unsaved", "sending", "edited"]);
  assert.equal(list[1], sending);
  assert.deepEqual(sending.delivery, { pending: true });
  assert.equal(list[2], edited);
  assert.equal(edited.comment, "changed there");
  // The comment changed, so the export of the old text does not carry over.
  assert.equal(edited.exported, undefined);
});

test("merge on hearing another tab keeps a part only this tab changed (a change it could not save yet)", () => {
  const before = item("a", "2026-01-01");
  const ours = [{ ...before, comment: "unsaved edit", localEdited: true }];
  const stored = [{ ...before, delivery: { ok: true, status: 201 } }];
  const { list } = mergeFeedbackLists(ours, stored, knownAs(before), { prefer: "stored" });
  assert.deepEqual([list[0].comment, list[0].localEdited, list[0].delivery.ok], ["unsaved edit", true, true]);
});

test("merge keeps the export marks of either side while the comment is the same", () => {
  for (const prefer of ["ours", "stored"]) {
    const ours = [item("a", "2026-01-01")];
    const stored = [item("a", "2026-01-01", { exported: true, exportedAt: "t", exportedFileName: "f.json" })];
    const { list } = mergeFeedbackLists(ours, stored, knownAs(ours[0]), { prefer });
    assert.deepEqual([list[0].exported, list[0].exportedAt, list[0].exportedFileName], [true, "t", "f.json"]);
  }
});

test("the fingerprints ignore key order and the image data a full storage drops, and tell the parts apart", () => {
  const full = { id: "a", comment: "c", screenshot: { status: "captured", dataUrl: "data:image/svg+xml;base64,AAAA" } };
  const compact = { screenshot: { persistedWithoutDataUrl: true, status: "captured" }, comment: "c", id: "a" };
  assert.deepEqual(feedbackFingerprints(full), feedbackFingerprints(compact));
  const edited = feedbackFingerprints({ ...full, comment: "d" });
  const delivered = feedbackFingerprints({ ...full, delivery: { ok: true } });
  const exported = feedbackFingerprints({ ...full, exported: true });
  const base = feedbackFingerprints(full);
  assert.deepEqual([edited.content !== base.content, edited.delivery === base.delivery, edited.marks === base.marks], [true, true, true]);
  assert.deepEqual([delivered.content === base.content, delivered.delivery !== base.delivery], [true, true]);
  assert.deepEqual([exported.content === base.content, exported.marks !== base.marks], [true, true]);
});
