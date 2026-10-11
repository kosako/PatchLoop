"use strict";

// What the widget lets out as page.url (#163): origin + path, plus only the
// query keys listed in keepQueryParams, for new comments and for comments
// saved earlier with more of the URL.

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

const PAGE = "https://demo.example/flow?step=2&token=abc&evidence=e1#access_token=zzz";

test("a new comment carries only origin and path by default", async () => {
  const w = widgetHarness();
  w.window.location.href = PAGE;
  w.init();
  await w.submit();
  assert.equal(JSON.parse(w.requests[0].body).page.url, "https://demo.example/flow");
  assert.equal(w.api.getFeedback()[0].page.url, "https://demo.example/flow");
});

test("keepQueryParams keeps the listed query keys and still drops the fragment", async () => {
  const w = widgetHarness();
  w.window.location.href = PAGE;
  w.init({ keepQueryParams: ["step", "evidence"] });
  await w.submit();
  assert.equal(JSON.parse(w.requests[0].body).page.url, "https://demo.example/flow?step=2&evidence=e1");
});

test("a malformed keepQueryParams warns and keeps no query", async () => {
  const w = widgetHarness();
  w.window.location.href = PAGE;
  w.init({ keepQueryParams: "step" });
  await w.submit();
  assert.equal(JSON.parse(w.requests[0].body).page.url, "https://demo.example/flow");
  assert.equal(w.warnings.filter(([message]) => String(message).includes("keepQueryParams")).length, 1);
});

test("a saved comment loses the dropped query on load, in storage, and in the export", async () => {
  const w = widgetHarness();
  w.window.location.href = PAGE;
  // Stands in for a comment saved before #163 with the token in its URL.
  w.init({ persistFeedback: true, deliveryMode: "download", keepQueryParams: ["step", "token"] });
  await w.submit("Saved earlier");
  assert.equal(w.api.getFeedback()[0].page.url, "https://demo.example/flow?step=2&token=abc");
  w.api.destroy();

  w.init({ persistFeedback: true, deliveryMode: "download", keepQueryParams: ["step"] });
  assert.equal(w.api.getFeedback()[0].page.url, "https://demo.example/flow?step=2");
  w.document.querySelector("[data-pl-download-all]").click();
  const bundle = JSON.parse(await w.downloads[0].blob.text());
  assert.equal(bundle.feedback[0].page.url, "https://demo.example/flow?step=2");
  w.api.destroy();

  // The load wrote the narrowed URL back, so a wider rule cannot restore it.
  w.init({ persistFeedback: true, deliveryMode: "download", keepQueryParams: ["step", "token"] });
  assert.equal(w.api.getFeedback()[0].page.url, "https://demo.example/flow?step=2");
});

test("retrying a saved comment sends it under the current rule", async () => {
  const w = widgetHarness({ replies: [new Error("network"), { ok: true, status: 201 }] });
  w.window.location.href = PAGE;
  w.init({ persistFeedback: true, keepQueryParams: ["step", "token"] });
  await w.submit("Failed earlier");
  assert.equal(JSON.parse(w.requests[0].body).page.url, "https://demo.example/flow?step=2&token=abc");
  w.api.destroy();

  w.init({ persistFeedback: true });
  const retry = w.document.querySelector("[data-pl-retry]");
  assert.ok(retry);
  await Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: retry }));
  assert.equal(w.requests.length, 2);
  assert.equal(JSON.parse(w.requests[1].body).page.url, "https://demo.example/flow");
});

test("a comment built before a re-init from onSubmit is sent under the new rule", async () => {
  const w = widgetHarness();
  w.window.location.href = PAGE;
  w.init({ keepQueryParams: ["step", "token"], onSubmit: () => w.init({ keepQueryParams: ["step"] }) });
  await w.submit();
  assert.equal(w.requests.length, 1);
  assert.equal(JSON.parse(w.requests[0].body).page.url, "https://demo.example/flow?step=2");
});

test("a comment built before a re-init from a patchloop:feedback listener reaches onSubmit under the new rule", async () => {
  const w = widgetHarness();
  w.window.location.href = PAGE;
  let received = null;
  w.document.addEventListener("patchloop:feedback", () => {
    w.init({ keepQueryParams: ["step"], onSubmit: (payload) => { received = payload.page.url; } });
  }, { once: true });
  w.init({ keepQueryParams: ["step", "token"] });
  await w.submit();
  assert.equal(received, "https://demo.example/flow?step=2");
  assert.equal(JSON.parse(w.requests[0].body).page.url, "https://demo.example/flow?step=2");
});
