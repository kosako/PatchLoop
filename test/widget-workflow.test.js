"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

test("editing a delivered comment marks it as a local change without pretending to resend", async () => {
  const w = widgetHarness();
  w.init({ persistFeedback: true });
  await w.submit("Original");
  const edit = w.document.querySelector("[data-pl-edit]");
  w.document.querySelector("[data-pl-list]").emit("click", { target: edit });
  assert.equal(w.document.querySelector("[data-pl-edit-note]").hidden, false);
  await w.submit("Changed", { captureTarget: false });
  assert.equal(w.requests.length, 1);
  assert.equal(JSON.parse(w.requests[0].body).comment, "Original");
  assert.equal(w.api.getFeedback()[0].localEdited, true);
  assert.match(w.document.querySelector("[data-pl-list]").innerHTML, /ローカル変更・送信先には未反映/);
  w.api.destroy();
  w.init({ persistFeedback: true });
  assert.equal(w.api.getFeedback()[0].localEdited, true);
});

test("failed delivery can be retried without adding a second local comment", async () => {
  const w = widgetHarness({ replies: [new Error("network"), { ok: true, status: 201 }] });
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

test("duplicate-ID response stays unresolved and does not offer blind repeated retries", async () => {
  const w = widgetHarness({ replies: [{ ok: false, status: 409 }] });
  w.init();
  await w.submit();
  assert.equal(w.api.getFeedback()[0].delivery.ok, false);
  assert.equal(w.document.querySelector("[data-pl-retry]"), null);
  assert.match(w.document.querySelector("[data-pl-notice]").textContent, /受信箱の内容を確認/);
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

test("editing an unconfirmed Slack delivery is explicitly a local-only change", async () => {
  const w = widgetHarness();
  w.init({ deliveryMode: "slack-webhook", slackWebhookUrl: "https://hooks.slack.test/example" });
  await w.submit("Original");
  assert.equal(w.api.getFeedback()[0].delivery.ok, null);
  w.document.querySelector("[data-pl-list]").emit("click", { target: w.document.querySelector("[data-pl-edit]") });
  await w.submit("Revised", { captureTarget: false });
  assert.equal(w.requests.length, 1);
  assert.equal(w.api.getFeedback()[0].localEdited, true);
});

test("restoring an interrupted delivery preserves the comment and offers recovery", async () => {
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
  assert.equal(w.api.getFeedback()[0].delivery.ok, false);
  assert.ok(w.document.querySelector("[data-pl-retry]"));
  assert.equal(w.document.querySelector("[data-pl-clear]").disabled, false);
});
