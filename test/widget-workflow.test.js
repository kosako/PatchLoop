"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

const UNANSWERED = "送信先から応答を受け取れなかったため、結果は未確認です。受信箱の内容を確認してから再送してください。";

test("editing a delivered comment sends a revision that takes its place in the list (#121)", async () => {
  const w = widgetHarness();
  w.init({ persistFeedback: true });
  await w.submit("Original");
  const originalId = w.api.getFeedback()[0].id;
  w.document.querySelector("[data-pl-edit]").click();
  const note = w.document.querySelector("[data-pl-edit-note]");
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /元のコメントの修正版/);
  await w.submit("Changed", { captureTarget: false });

  assert.equal(w.requests.length, 2);
  const revision = JSON.parse(w.requests[1].body);
  assert.deepEqual([revision.comment, revision.replaces, revision.schemaVersion], ["Changed", originalId, 4]);
  assert.notEqual(revision.id, originalId);
  assert.deepEqual(JSON.parse(w.requests[0].body).target, revision.target);
  assert.equal(w.api.getFeedback().length, 1);
  assert.deepEqual([w.api.getFeedback()[0].id, w.api.getFeedback()[0].delivery.ok], [revision.id, true]);
  assert.equal(w.document.querySelectorAll("[data-patchloop-pin]").length, 1);
  assert.doesNotMatch(w.document.querySelector("[data-pl-list]").innerHTML, /ローカル変更/);
  w.api.destroy();
  w.init({ persistFeedback: true });
  assert.deepEqual([w.api.getFeedback().length, w.api.getFeedback()[0].replaces], [1, originalId]);
});

test("editing a comment that has not left this device changes it in place", async () => {
  // The receiver answered it did not take it (#152): a post with no answer may
  // have reached it.
  const w = widgetHarness({ replies: [{ ok: false, status: 500 }] });
  w.init();
  await w.submit("Not delivered");
  const id = w.api.getFeedback()[0].id;
  w.document.querySelector("[data-pl-edit]").click();
  assert.equal(w.document.querySelector("[data-pl-edit-note]").textContent, "編集はこの端末に保存されます。");
  await w.submit("Fixed before the retry", { captureTarget: false });
  assert.equal(w.requests.length, 1);
  assert.deepEqual([w.api.getFeedback()[0].id, w.api.getFeedback()[0].comment, w.api.getFeedback()[0].replaces], [id, "Fixed before the retry", undefined]);
});

test("failed delivery can be retried without adding a second local comment", async () => {
  const w = widgetHarness({ replies: [{ ok: false, status: 500 }, { ok: true, status: 201 }] });
  w.init();
  await w.submit("Retry me");
  const originalId = w.api.getFeedback()[0].id;
  const retry = w.document.querySelector("[data-pl-retry]");
  assert.ok(retry);
  await Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: retry }));
  assert.equal(w.requests.length, 2);
  assert.equal(JSON.parse(w.requests[1].body).id, originalId);
  assert.equal(w.api.getFeedback().length, 1);
  assert.equal(w.api.getFeedback()[0].delivery.ok, true);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
});

test("duplicate-ID response shows as received, in a text not confirmed, and does not offer blind repeated retries (#152)", async () => {
  const w = widgetHarness({ replies: [{ ok: false, status: 409 }] });
  w.init();
  await w.submit();
  assert.equal(w.api.getFeedback()[0].delivery.ok, false);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
  const received = "同じ ID のコメントが受信済みです（内容は未確認）。受信箱の内容を確認してください。";
  assert.equal(w.document.querySelector("[data-pl-notice]").textContent, received);
  assert.equal(w.document.querySelector("[data-pl-notice]").dataset.state, "success");
  assert.equal(w.document.querySelector(".pl-feedback-status-ok").textContent, "受信済み");
  assert.equal(w.document.querySelector(".pl-feedback-status-ok").getAttribute("title"), received);
});

test("editing a comment the receiver already held (409) sends it as a revision (#187, #121)", async () => {
  const w = widgetHarness({ replies: [{ ok: false, status: 409 }] });
  w.init();
  await w.submit("Original");
  const originalId = w.api.getFeedback()[0].id;
  w.document.querySelector("[data-pl-edit]").click();
  await w.submit("Changed", { captureTarget: false });
  assert.equal(w.requests.length, 2);
  assert.deepEqual([JSON.parse(w.requests[1].body).replaces, w.api.getFeedback()[0].delivery.ok], [originalId, true]);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
});

test("a reviewer can omit the screenshot for one comment", async () => {
  const w = widgetHarness();
  w.init({ captureScreenshot: true });
  w.capture();
  const input = w.document.querySelector("[data-pl-include-screenshot]");
  assert.equal(input.checked, true);
  input.checked = false;
  await w.submit("No screenshot", { captureTarget: false });
  assert.equal(JSON.parse(w.requests[0].body).screenshot, null);
});

test("a second download remains available and strips local export bookkeeping", async () => {
  const w = widgetHarness();
  w.init({ deliveryMode: "download" });
  await w.submit("Share by file");
  w.document.querySelector("[data-pl-download-all]").click();
  assert.equal(w.downloads.length, 1);
  assert.equal(w.api.getFeedback()[0].exported, true);
  assert.equal(w.document.querySelector("[data-pl-download-again]").hidden, false);
  w.document.querySelector("[data-pl-download-again]").click();
  assert.equal(w.downloads.length, 2);
  const bundle = JSON.parse(await w.downloads[1].blob.text());
  assert.equal(bundle.version, 2);
  assert.equal(bundle.feedback[0].id, w.api.getFeedback()[0].id);
  assert.equal(bundle.feedback[0].comment, "Share by file");
  assert.equal(Object.hasOwn(bundle.feedback[0], "exported"), false);
});

test("keyboard users can capture a focused page control and cancel selection mode", async () => {
  const w = widgetHarness();
  w.init();
  w.api.setFeedbackMode(true);
  w.target.focus();
  // An overlay at the control's center must not replace the focused target.
  w.document.elementFromPoint = () => w.document.body;
  w.document.emit("keydown", { key: "Enter", target: w.target });
  assert.equal(w.document.querySelector("[data-pl-comment]").hidden, false);
  await w.submit("Keyboard comment", { captureTarget: false });
  assert.equal(w.api.getFeedback()[0].target.selector, "#review-target");
  w.document.emit("keydown", { key: "Escape", target: w.target });
  assert.equal(w.document.querySelector("[data-pl-mode]").getAttribute("aria-pressed"), "false");
});

test("touch taps create a point; scrolling and pointer cancellation create nothing", () => {
  const w = widgetHarness({ pointerEvents: true });
  w.init();
  w.api.setFeedbackMode(true);
  const event = { target: w.target, button: 0, isPrimary: true, pointerType: "touch", clientX: 20, clientY: 30 };
  w.document.emit("pointerdown", event);
  w.document.emit("pointermove", { ...event, clientY: 80 });
  w.document.emit("pointerup", { ...event, clientY: 80 });
  assert.equal(w.document.querySelectorAll("[data-patchloop-pin]").length, 0);
  w.document.emit("pointerdown", event);
  w.document.emit("pointercancel", event);
  w.document.emit("pointerup", event);
  assert.equal(w.document.querySelectorAll("[data-patchloop-pin]").length, 0);
  w.document.emit("pointerdown", event);
  w.document.emit("pointerup", event);
  assert.equal(w.document.querySelectorAll("[data-patchloop-pin]").length, 1);
  assert.equal(w.document.querySelector("[data-pl-comment]").hidden, false);
});

test("public selection API is safe before init and after destroy", () => {
  const w = widgetHarness();
  w.api.setFeedbackMode(true);
  w.init();
  w.api.destroy();
  w.api.setFeedbackMode(true);
  assert.equal(w.document.querySelectorAll("[data-patchloop-root]").length, 0);
});

test("selection mode moves focus to the guide and Escape returns to the launcher", () => {
  const w = widgetHarness();
  w.init();
  w.document.querySelector("[data-pl-mode]").focus();
  w.document.querySelector("[data-pl-mode]").click();
  const stop = w.document.querySelector("[data-pl-stop-capture]");
  assert.equal(w.document.activeElement, stop);
  w.document.emit("keydown", { key: "Escape", target: stop });
  assert.equal(w.document.querySelector("[data-pl-capture-guide]").hidden, true);
  assert.equal(w.document.activeElement, w.document.querySelector("[data-pl-collapse]"));
});

test("keyboard selection never targets PatchLoop point or area markers", async () => {
  for (const area of [false, true]) {
    const w = widgetHarness();
    w.init();
    await w.submit("Existing", { area });
    w.api.setFeedbackMode(true);
    const marker = w.document.querySelector(area ? "[data-patchloop-area]" : "[data-patchloop-pin]");
    const target = area ? marker.querySelector("button") : marker;
    target.focus();
    w.document.emit("keydown", { key: "Enter", target });
    assert.equal(w.document.querySelector("[data-pl-comment]").hidden, true);
    assert.equal(w.api.getFeedback().length, 1);
  }
});

test("editing an unconfirmed Slack delivery posts the revision to Slack too (#121)", async () => {
  const w = widgetHarness();
  w.init({ deliveryMode: "slack-webhook", slackWebhookUrl: "https://hooks.slack.test/example" });
  await w.submit("Original");
  const originalId = w.api.getFeedback()[0].id;
  assert.equal(w.api.getFeedback()[0].delivery.ok, null);
  w.document.querySelector("[data-pl-edit]").click();
  await w.submit("Revised", { captureTarget: false });
  assert.equal(w.requests.length, 2);
  assert.deepEqual([w.api.getFeedback().length, w.api.getFeedback()[0].replaces, w.api.getFeedback()[0].comment], [1, originalId, "Revised"]);
});

test("restoring an interrupted delivery preserves the comment and offers recovery; an edit then goes as a revision (#121)", async () => {
  let complete;
  const w = widgetHarness({ replies: [() => new Promise((resolve) => { complete = resolve; })] });
  w.init({ persistFeedback: true });
  const submission = w.submit("Pending at reload");
  assert.equal(w.api.getFeedback()[0].delivery.pending, true);
  w.api.destroy();
  w.init({ persistFeedback: true });
  assert.equal(w.api.getFeedback()[0].comment, "Pending at reload");
  assert.equal(w.api.getFeedback()[0].delivery.ok, null);
  assert.equal(w.api.getFeedback()[0].delivery.interrupted, true);
  assert.ok(w.document.querySelector("[data-pl-retry]"));
  const notice = w.document.querySelector("[data-pl-notice]");
  const noticeBefore = notice.textContent;
  complete({ ok: true, status: 201 });
  await submission;
  assert.equal(notice.textContent, noticeBefore);
  assert.equal(w.api.getFeedback()[0].delivery.ok, null);
  // The receiver may hold the cut-off delivery, so the edit is a revision.
  const originalId = w.api.getFeedback()[0].id;
  w.document.querySelector("[data-pl-edit]").click();
  await w.submit("Corrected before retry", { captureTarget: false });
  assert.equal(w.requests.length, 2);
  assert.deepEqual([JSON.parse(w.requests[1].body).comment, JSON.parse(w.requests[1].body).replaces], ["Corrected before retry", originalId]);
  assert.deepEqual([w.api.getFeedback().length, w.api.getFeedback()[0].delivery.ok], [1, true]);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
});

test("interrupted Slack delivery keeps its destination and does not offer a duplicate-prone retry", async () => {
  let complete;
  const w = widgetHarness({ replies: [() => new Promise((resolve) => { complete = resolve; })] });
  const options = { persistFeedback: true, deliveryMode: "slack-webhook", slackWebhookUrl: "https://hooks.slack.test/example" };
  w.init(options);
  const submission = w.submit("Pending Slack");
  w.api.destroy();
  w.init(options);
  assert.equal(w.api.getFeedback()[0].delivery.target, "slack-webhook");
  assert.equal(w.api.getFeedback()[0].delivery.ok, null);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
  assert.match(w.document.querySelector("[data-pl-list]").innerHTML, /Slack 側で内容を確認/);
  complete({ ok: true });
  await submission;
});

test("a retry completing after reinitialization cannot announce success in a different demo", async () => {
  let complete;
  const w = widgetHarness({ replies: [new Error("offline"), () => new Promise((resolve) => { complete = resolve; })] });
  w.init();
  await w.submit("Retry later");
  const retry = w.document.querySelector("[data-pl-retry]");
  const retried = Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: retry }));
  w.api.destroy();
  w.init({ demoId: "another-demo" });
  const notice = w.document.querySelector("[data-pl-notice]");
  const before = notice.textContent;
  complete({ ok: true, status: 201 });
  await retried;
  assert.equal(w.api.getFeedback().length, 0);
  assert.equal(notice.textContent, before);
});

test("a stalled request times out, preserves the comment, and offers retry", async () => {
  const w = widgetHarness({ replies: [(options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })] });
  w.init({ persistFeedback: true });
  let timeout;
  const originalTimer = w.window.setTimeout;
  w.window.setTimeout = (callback, milliseconds) => {
    if (milliseconds === 15000) { timeout = callback; return 123; }
    return originalTimer(callback, milliseconds);
  };
  const submission = w.submit("Keep this on timeout");
  assert.equal(w.api.getFeedback()[0].delivery.pending, true);
  assert.equal(w.document.querySelector("[data-pl-clear]").disabled, true);
  timeout();
  await submission;
  // The receiver may have taken it before the timeout (#152).
  const delivery = w.api.getFeedback()[0].delivery;
  assert.equal(`${delivery.ok} ${delivery.interrupted} ${delivery.unanswered}`, "null true true");
  assert.equal(w.document.querySelector(".pl-feedback-status-unknown").textContent, "結果未確認");
  assert.equal(w.document.querySelector("[data-pl-notice]").textContent, UNANSWERED);
  assert.ok(w.document.querySelector("[data-pl-retry]"));
  assert.equal(w.document.querySelector("[data-pl-clear]").disabled, false);
});

test("a network error leaves the result unknown and offers retry; a 409 on the retry shows it received (#152)", async () => {
  const w = widgetHarness({ replies: [new TypeError("Failed to fetch"), { ok: false, status: 409, json: async () => ({ ok: false, error: "Feedback already exists" }) }] });
  w.init();
  await w.submit("Did it arrive?");
  assert.equal(w.document.querySelector(".pl-feedback-status-unknown").textContent, "結果未確認");
  assert.equal(w.document.querySelector("[data-pl-notice]").textContent, UNANSWERED);
  assert.equal(w.document.querySelector("[data-pl-notice]").dataset.state, "success");
  const retry = w.document.querySelector("[data-pl-retry]");
  await Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: retry }));
  assert.equal(w.requests.length, 2);
  assert.equal(w.document.querySelector(".pl-feedback-status-ok").textContent, "受信済み");
  assert.equal(w.document.querySelector("[data-pl-notice]").dataset.state, "success");
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
});

test("a refusal of the comment as it is shows why and is resent only once the comment is edited (#152)", async () => {
  const reason = "feedback.comment exceeds the maximum length of 10 characters";
  const w = widgetHarness({ replies: [{ ok: false, status: 413, json: async () => ({ ok: false, error: reason }) }, { ok: true, status: 201 }] });
  w.init();
  await w.submit("Far too long for it");
  const refused = `送信先が受け取りを拒否しました（${reason}）。同じ内容では再送できません。コメントはこの端末に残っています。編集すると再送できるようになります。`;
  assert.equal(w.document.querySelector("[data-pl-notice]").textContent, refused);
  assert.equal(w.document.querySelector("[data-pl-notice]").dataset.state, "error");
  assert.equal(w.document.querySelector(".pl-feedback-status-fail").getAttribute("title"), refused);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);

  // It has not left this device, so the edit changes it in place.
  const id = w.api.getFeedback()[0].id;
  w.document.querySelector("[data-pl-edit]").click();
  await w.submit("Short", { captureTarget: false });
  assert.equal(`${w.api.getFeedback().length} ${w.api.getFeedback()[0].id === id}`, "1 true");
  const retry = w.document.querySelector("[data-pl-retry]");
  assert.ok(retry);
  await Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: retry }));
  assert.equal(`${w.requests.length} ${JSON.parse(w.requests[1].body).comment} ${w.api.getFeedback()[0].delivery.ok}`, "2 Short true");
});

test("a refusal for the receiver's settings keeps the retry (#152)", async () => {
  const w = widgetHarness({ replies: [{ ok: false, status: 403, json: async () => ({ ok: false, error: "Origin not allowed" }) }] });
  w.init();
  await w.submit();
  assert.equal(w.document.querySelector("[data-pl-notice]").textContent, "送信先の設定の問題で受け取られませんでした（Origin not allowed）。設定が直ってから再送してください。コメントはこの端末に残っています。");
  assert.ok(w.document.querySelector("[data-pl-retry]"));
});

test("an answer whose body cannot be read keeps its status (#152)", async () => {
  const unreadable = widgetHarness({ replies: [{ ok: false, status: 400, json: async () => { throw new SyntaxError("Unexpected token"); } }] });
  unreadable.init();
  await unreadable.submit();
  assert.equal(JSON.stringify(unreadable.api.getFeedback()[0].delivery), '{"ok":false,"status":400,"sent":{"comment":"Please fix this","reviewer":"Reviewer"}}');
  assert.equal(unreadable.document.querySelector("[data-pl-retry]"), null);

  // A body still on its way at the timeout is given up, and the status stays.
  let reading;
  const bodyRead = new Promise((resolve) => { reading = resolve; });
  const stalled = widgetHarness({ replies: [(options) => ({
    ok: false,
    status: 413,
    json: () => {
      reading();
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  })] });
  stalled.init();
  let timeout;
  const originalTimer = stalled.window.setTimeout;
  stalled.window.setTimeout = (callback, milliseconds) => {
    if (milliseconds === 15000) { timeout = callback; return 123; }
    return originalTimer(callback, milliseconds);
  };
  const submission = stalled.submit();
  assert.equal(await Promise.race([bodyRead.then(() => "body read"), submission.then(() => "settled unread")]), "body read");
  timeout();
  await submission;
  assert.equal(`${stalled.api.getFeedback()[0].delivery.ok} ${stalled.api.getFeedback()[0].delivery.status}`, "false 413");
});

test("a comment that is still sending cannot be edited or deleted", async () => {
  let complete;
  const w = widgetHarness({ replies: [() => new Promise((resolve) => { complete = resolve; })] });
  w.init();
  const submission = w.submit("Still sending");
  const edit = w.document.querySelector("[data-pl-edit]");
  const remove = w.document.querySelector("[data-pl-delete]");
  assert.equal(edit.disabled, true);
  assert.equal(remove.disabled, true);
  edit.focus();
  edit.click();
  remove.click();
  assert.notEqual(w.document.activeElement, edit);
  assert.equal(w.document.querySelector("[data-pl-comment]").hidden, true);
  assert.equal(w.api.getFeedback().length, 1);
  complete({ ok: true, status: 201 });
  await submission;
  w.document.querySelector("[data-pl-edit]").click();
  assert.equal(w.document.querySelector("[data-pl-comment]").hidden, false);
});

test("delivery settings switch the destination used by the next comment", async () => {
  const w = widgetHarness();
  w.init({ showDeliverySettings: true });
  const settings = w.document.querySelector("[data-pl-delivery-settings]");
  const mode = settings.querySelector("[data-pl-delivery-mode]");
  assert.equal(mode.value, "receiver");
  assert.equal(settings.querySelector("[data-pl-endpoint]").value, "https://receiver.example/feedback");
  assert.equal(settings.querySelector("[data-pl-endpoint-field]").hidden, false);
  assert.equal(settings.querySelector("[data-pl-slack-field]").hidden, true);
  mode.value = "slack-webhook";
  settings.querySelector("[data-pl-slack-webhook]").value = " https://hooks.slack.test/settings ";
  settings.emit("change", { target: mode });
  assert.equal(settings.querySelector("[data-pl-endpoint-field]").hidden, true);
  assert.equal(settings.querySelector("[data-pl-slack-field]").hidden, false);
  await w.submit("Sent through the settings");
  assert.equal(w.requests.length, 1);
  assert.equal(w.requests[0].url, "https://hooks.slack.test/settings");
  assert.equal(w.requests[0].mode, "no-cors");
  assert.equal(w.api.getFeedback()[0].delivery.target, "slack-webhook");
});
