"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: a failing comparison would
// inspect their parent / child links. Compare strings and booleans instead.

// The lookup is asynchronous; let its fetch and json() settle.
async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function answer(statuses) {
  return () => ({ ok: true, status: 200, json: async () => ({ ok: true, statuses }) });
}

async function sendTwo(widget) {
  await widget.submit("First comment");
  await widget.submit("Second comment", { area: true });
  widget.api.setFeedbackMode(false);
  const [second, first] = widget.api.getFeedback().map((item) => item.id);
  return { first, second };
}

// Opening the panel is one of the moments the widget asks.
async function reopenPanel(widget) {
  const toggle = widget.document.querySelector("[data-pl-collapse]");
  toggle.click();
  toggle.click();
  await settle();
}

function chooseDisplayMode(widget, mode) {
  const fieldset = widget.document.querySelector("[data-pl-display-mode]");
  const radio = fieldset.querySelector(`input[value="${mode}"]`);
  radio.checked = true;
  fieldset.emit("change", { target: radio });
}

function markerState(widget, id) {
  const node = widget.document.querySelector(`[data-patchloop-feedback-id="${id}"]`);
  return { hidden: node.hidden, done: node.classList.contains("pl-marker-done"), dot: node.classList.contains("pl-marker-dot") };
}

function chipText(widget, id) {
  const item = widget.document.querySelector(`[data-feedback-id="${id}"]`);
  const chip = item.querySelector(".pl-inbox-status");
  return chip ? chip.textContent : null;
}

test("finished comments are hidden in 通常 and the list shows each inbox status (#147)", async () => {
  let ids;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id: ids.first, status: "fixed" }, { id: ids.second, status: "new" }])(query) });
  widget.init();
  ids = await sendTwo(widget);
  await reopenPanel(widget);

  assert.equal(widget.statusRequests.length, 1);
  assert.equal(widget.statusRequests[0].url, "https://receiver.example/feedback-status");
  assert.deepEqual(JSON.parse(widget.statusRequests[0].body), { projectId: "local-demo", ids: [ids.second, ids.first] });
  assert.deepEqual(markerState(widget, ids.first), { hidden: true, done: false, dot: false });
  assert.deepEqual(markerState(widget, ids.second), { hidden: false, done: false, dot: false });
  assert.equal(chipText(widget, ids.first), "受信箱: 修正済み");
  assert.equal(chipText(widget, ids.second), "受信箱: 未確認");
  // The delivery requests are counted apart from the lookup.
  assert.equal(widget.requests.length, 2);
});

test("ドットだけ also hides finished comments; 全部 shows them grayed out (#147)", async () => {
  let ids;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id: ids.first, status: "ignored" }, { id: ids.second, status: "accepted" }])(query) });
  widget.init();
  ids = await sendTwo(widget);
  await reopenPanel(widget);

  chooseDisplayMode(widget, "dots");
  assert.deepEqual(markerState(widget, ids.first), { hidden: true, done: false, dot: true });
  assert.deepEqual(markerState(widget, ids.second), { hidden: false, done: false, dot: true });
  chooseDisplayMode(widget, "all");
  assert.deepEqual(markerState(widget, ids.first), { hidden: false, done: true, dot: false });
  assert.deepEqual(markerState(widget, ids.second), { hidden: false, done: false, dot: false });
  chooseDisplayMode(widget, "normal");
  assert.deepEqual(markerState(widget, ids.first), { hidden: true, done: false, dot: false });
  assert.equal(chipText(widget, ids.first), "受信箱: 見送り");
  assert.equal(chipText(widget, ids.second), "受信箱: 対応予定");
});

test("a comment missing from the answer is marked as not in the inbox and stays visible (#147)", async () => {
  let ids;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id: ids.second, status: "fixed" }])(query) });
  widget.init();
  ids = await sendTwo(widget);
  await reopenPanel(widget);
  assert.equal(chipText(widget, ids.first), "受信箱に無い");
  assert.equal(markerState(widget, ids.first).hidden, false);
  assert.equal(markerState(widget, ids.second).hidden, true);
});

test("a comment edited here after it was sent is not treated as finished (#147)", async () => {
  let id;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id, status: "fixed" }])(query) });
  widget.init();
  await widget.submit("Before the edit");
  widget.api.setFeedbackMode(false);
  [id] = widget.api.getFeedback().map((item) => item.id);
  widget.document.querySelector("[data-pl-edit]").click();
  widget.document.querySelector("[data-pl-comment-text]").value = "After the edit";
  await Promise.all(widget.document.querySelector("[data-pl-comment]").emit("submit"));
  assert.equal(widget.api.getFeedback()[0].localEdited, true);
  await reopenPanel(widget);
  assert.equal(markerState(widget, id).hidden, false);
  assert.equal(chipText(widget, id), "受信箱: 修正済み");
});

test("when the lookup fails or the receiver has none, nothing is hidden and nothing is shown (#147)", async () => {
  for (const statusReply of [
    () => { throw new Error("Failed to fetch"); },
    () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }),
    () => ({ ok: true, status: 200, json: async () => ({ ok: true, statuses: "broken" }) }),
    undefined
  ]) {
    const widget = widgetHarness(statusReply ? { statusReply } : {});
    widget.init();
    const ids = await sendTwo(widget);
    await reopenPanel(widget);
    assert.equal(widget.statusRequests.length, 1);
    for (const id of [ids.first, ids.second]) {
      assert.equal(markerState(widget, id).hidden, false);
      assert.equal(chipText(widget, id), null);
    }
    // Asking again right away is held back (a backoff, or a stop on 404).
    await reopenPanel(widget);
    assert.equal(widget.statusRequests.length, 1);
  }
});

test("a successful lookup is not repeated within the minimum gap (#147)", async () => {
  let ids;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id: ids.first, status: "new" }])(query) });
  widget.init();
  ids = await sendTwo(widget);
  await reopenPanel(widget);
  await reopenPanel(widget);
  assert.equal(widget.statusRequests.length, 1);
});

test("the lookup sends the ingest key and runs on init for restored comments (#147)", async () => {
  let id;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id, status: "fixed" }])(query) });
  widget.init({ persistFeedback: true, ingestKey: "pk_demo", projectId: "demo-project" });
  await widget.submit("Restored later");
  widget.api.setFeedbackMode(false);
  [id] = widget.api.getFeedback().map((item) => item.id);
  assert.equal(widget.statusRequests.length, 0);

  widget.init({ persistFeedback: true, ingestKey: "pk_demo", projectId: "demo-project" });
  await settle();
  assert.equal(widget.statusRequests.length, 1);
  assert.equal(widget.statusRequests[0].headers["X-PatchLoop-Ingest-Key"], "pk_demo");
  assert.deepEqual(JSON.parse(widget.statusRequests[0].body), { projectId: "demo-project", ids: [id] });
  assert.equal(markerState(widget, id).hidden, true);
  // The status stays in memory: the comment that is stored and exported does
  // not carry it.
  assert.equal(Object.hasOwn(widget.api.getFeedback()[0], "status"), false);
});

test("no lookup without a receiver: other delivery modes and endpoints not ending in /feedback (#147)", async () => {
  for (const options of [{ deliveryMode: "download" }, { endpoint: "https://receiver.example/inbox" }]) {
    const widget = widgetHarness({ statusReply: answer([]) });
    widget.init(options);
    await widget.submit("Not asked about");
    widget.api.setFeedbackMode(false);
    await reopenPanel(widget);
    assert.equal(widget.statusRequests.length, 0);
  }
});

test("the 15 second timeout also covers a body that stalls after the headers (#147)", async () => {
  const pending = new Map();
  let nextId = 0;
  const timers = {
    setTimeout: (callback, ms) => {
      nextId += 1;
      pending.set(nextId, { callback, ms });
      return nextId;
    },
    clearTimeout: (id) => pending.delete(id)
  };
  const widget = widgetHarness({
    timers,
    statusReply: (query, options) => ({
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("body aborted"))))
    })
  });
  widget.init();
  await sendTwo(widget);
  await reopenPanel(widget);
  assert.equal(widget.statusRequests.length, 1);
  const timeouts = [...pending.values()].filter((timer) => timer.ms === 15000);
  assert.equal(timeouts.length, 1, "the lookup's timeout is still armed while the body is read");
  timeouts[0].callback();
  await settle();
  assert.ok(widget.infos.some(([message]) => message === "[PatchLoop] inbox status lookup failed"));
});

test("an answer that comes back after a re-init is dropped and does not unlock another lookup (#147)", async () => {
  const answers = [];
  const widget = widgetHarness({ statusReply: () => new Promise((resolve) => answers.push(resolve)) });
  widget.init({ persistFeedback: true });
  const ids = await sendTwo(widget);
  await reopenPanel(widget);
  assert.equal(widget.statusRequests.length, 1);
  // Re-init asks again for the restored comments while the first is still out.
  widget.init({ persistFeedback: true });
  await settle();
  assert.equal(widget.statusRequests.length, 2);

  answers[0](answer([{ id: ids.first, status: "fixed" }])());
  await settle();
  assert.equal(markerState(widget, ids.first).hidden, false, "the answer to the first lookup is dropped");
  await reopenPanel(widget);
  assert.equal(widget.statusRequests.length, 2, "the second lookup is still out, so no third starts");

  answers[1](answer([{ id: ids.first, status: "fixed" }])());
  await settle();
  assert.equal(markerState(widget, ids.first).hidden, true);
});

test("changing the delivery settings away from the receiver shows every marker again (#147)", async () => {
  let ids;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id: ids.first, status: "fixed" }])(query) });
  widget.init({ showDeliverySettings: true });
  ids = await sendTwo(widget);
  await reopenPanel(widget);
  assert.equal(markerState(widget, ids.first).hidden, true);
  const select = widget.document.querySelector("[data-pl-delivery-mode]");
  select.value = "download";
  widget.document.querySelector("[data-pl-delivery-settings]").emit("change", { target: select });
  assert.equal(markerState(widget, ids.first).hidden, false);
  assert.equal(chipText(widget, ids.first), null);
});

test("opening the panel from a marker asks too (#147)", async () => {
  let ids;
  const widget = widgetHarness({ statusReply: (query) => answer([{ id: ids.first, status: "new" }])(query) });
  widget.init();
  ids = await sendTwo(widget);
  assert.equal(widget.statusRequests.length, 0, "sending a comment does not ask");
  widget.document.querySelector("[data-pl-collapse]").click();
  widget.document.querySelector(`[data-patchloop-feedback-id="${ids.first}"]`).click();
  await settle();
  assert.equal(widget.statusRequests.length, 1);
  assert.equal(chipText(widget, ids.first), "受信箱: 未確認");
});

test("a relative endpoint is resolved like fetch does, against the document base URL (#147)", async () => {
  const widget = widgetHarness({ statusReply: answer([]) });
  widget.document.baseURI = "https://demo.example/receiver/";
  widget.init({ endpoint: "feedback" });
  await sendTwo(widget);
  await reopenPanel(widget);
  assert.equal(widget.statusRequests[0].url, "https://demo.example/receiver/feedback-status");
});
