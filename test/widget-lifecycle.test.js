"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

test("destroy cancels initialization waiting for DOM readiness", () => {
  const widget = widgetHarness({ ready: false });
  widget.init();
  widget.api.destroy();
  widget.ready();
  assert.equal(widget.roots().length, 0);
});

test("repeated early init uses only the latest options and can be destroyed", async () => {
  const widget = widgetHarness({ ready: false });
  widget.init({ projectId: "first", onSubmit() { throw new Error("superseded callback"); } });
  widget.init({ projectId: "latest" });
  widget.ready();
  assert.equal(widget.roots().length, 1);
  assert.equal(widget.mountCount(), 1);
  await widget.submit();
  assert.equal(widget.requests.length, 1);
  assert.equal(JSON.parse(widget.requests[0].body).projectId, "latest");
  assert.equal(widget.warnings.length, 0);
  widget.api.destroy();
  assert.equal(widget.roots().length, 0);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 0);
});

for (const failure of ["synchronous", "asynchronous"]) {
  test(`${failure} onSubmit failure is reported and receiver delivery completes`, async () => {
    const widget = widgetHarness();
    const error = new Error(`${failure} callback failure`);
    widget.init({ onSubmit: failure === "synchronous" ? () => { throw error; } : () => Promise.reject(error) });
    await widget.submit();
    assert.equal(widget.requests.length, 1);
    assert.equal(widget.requests[0].url, "https://receiver.example/feedback");
    assert.equal(widget.api.getFeedback()[0].delivery.ok, true);
    assert.equal(widget.warnings.length, 1);
    assert.equal(widget.warnings[0][0], "[PatchLoop] onSubmit failed");
    assert.equal(widget.warnings[0][1], error);
  });
}

test("delivery does not wait for an unsettled onSubmit Promise", { timeout: 1000 }, async () => {
  const widget = widgetHarness();
  widget.init({ onSubmit: () => new Promise(() => {}) });
  await widget.submit();
  assert.equal(widget.requests.length, 1);
  assert.equal(widget.api.getFeedback()[0].delivery.ok, true);
});

test("onSubmit still runs synchronously before the payload is delivered", async () => {
  const widget = widgetHarness();
  widget.init({ onSubmit(payload) { payload.customContext = "from callback"; } });
  await widget.submit();
  assert.equal(JSON.parse(widget.requests[0].body).customContext, "from callback");
});

test("callback rejection does not interrupt direct Slack delivery", async () => {
  const widget = widgetHarness();
  widget.init({ deliveryMode: "slack-webhook", slackWebhookUrl: "https://hooks.slack.com/services/test", onSubmit: () => Promise.reject(new Error("callback failure")) });
  await widget.submit();
  assert.equal(widget.requests.length, 1);
  assert.equal(widget.requests[0].mode, "no-cors");
  assert.equal(widget.api.getFeedback()[0].delivery.target, "slack-webhook");
  assert.equal(widget.warnings.length, 1);
});
