"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { bundle, widgetHarness } = require("../test-support/widget-dom.js");

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

test("every hook the widget queries is rendered by its markup", () => {
  // Hooks behind ?. fail silently in a browser when the template drops them,
  // so check each one the bundle looks up against the parsed markup.
  const hooks = new Set([...bundle.matchAll(/querySelector\("\[(data-pl-[\w-]+)\]"\)/g)].map((match) => match[1]));
  for (const hook of ["data-pl-include-screenshot", "data-pl-notice", "data-pl-download-again", "data-pl-delivery-mode"]) assert.ok(hooks.has(hook), hook);
  const widget = widgetHarness();
  widget.init({ showDeliverySettings: true });
  const root = widget.roots()[0];
  for (const hook of hooks) assert.ok(root.querySelector(`[${hook}]`), `${hook} is missing from the rendered widget`);
});

test("harness keeps disabled, hidden and data-* in sync between attributes and properties", () => {
  // The widget toggles these through both properties and attributes, and the
  // tests read them through click(), focus() and selectors, so the harness has
  // to agree with a browser either way.
  const widget = widgetHarness();
  widget.init();
  const root = widget.roots()[0];
  const button = root.querySelector("button");
  let clicks = 0;
  button.addEventListener("click", () => { clicks += 1; });

  button.setAttribute("disabled", "");
  assert.equal(button.disabled, true);
  assert.ok(button.matches("[disabled]"));
  button.click();
  assert.equal(clicks, 0);
  button.removeAttribute("disabled");
  assert.equal(button.disabled, false);
  assert.equal(button.matches("[disabled]"), false);
  button.click();
  assert.equal(clicks, 1);

  button.hidden = true;
  assert.ok(button.matches("[hidden]"));
  button.hidden = false;
  assert.equal(button.matches("[hidden]"), false);
  button.setAttribute("hidden", "");
  assert.equal(button.hidden, true);

  button.setAttribute("data-harness-probe", "on");
  assert.equal(button.dataset.harnessProbe, "on");
  assert.equal(root.querySelector('[data-harness-probe="on"]'), button);
  button.removeAttribute("data-harness-probe");
  assert.equal(root.querySelector("[data-harness-probe]"), null);
});
