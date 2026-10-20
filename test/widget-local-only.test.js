"use strict";

// The marks the widget keeps with a comment on the device only (#170) stay
// here: what it sends to the receiver and what it exports leave them out.

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");
const { LOCAL_ONLY_KEYS, LOCAL_ONLY_SCREENSHOT_KEYS, toWireFeedback } = require("../shared/local-only.js");

const retryOf = (w) => Promise.all(w.document.querySelector("[data-pl-list]").emit("click", { target: w.document.querySelector("[data-pl-retry]") }));
const exportAll = (w) => w.document.querySelector("[data-pl-download-all]").click();
// The marks on a comment as it left, or as it is held here, by name.
const marks = (item) => [
  ...LOCAL_ONLY_KEYS.filter((key) => Object.hasOwn(item, key)),
  ...LOCAL_ONLY_SCREENSHOT_KEYS.filter((key) => Object.hasOwn(item.screenshot || {}, key)).map((key) => `screenshot.${key}`)
].join(",");

// Rewrites the saved comments as a save that did not fit the storage writes
// them: without the image data, marked so (persistedWithoutDataUrl).
function saveWithoutImageData(storage) {
  const [key, value] = [...storage.entries()].find(([name]) => name.startsWith("patchloop:feedback:"));
  const envelope = JSON.parse(value);
  envelope.feedback.forEach((item) => {
    item.screenshot = { status: "captured", kind: "viewport-svg", mimeType: "image/svg+xml", persistedWithoutDataUrl: true };
  });
  storage.set(key, JSON.stringify(envelope));
}

test("a comment goes to the receiver without the delivery state it is given before it leaves (#170)", async () => {
  const w = widgetHarness();
  w.init();
  await w.submit("Sent");
  assert.equal(w.requests.length, 1);
  assert.equal(marks(JSON.parse(w.requests[0].body)), "");
  assert.equal(w.api.getFeedback()[0].delivery.ok, true);
});

test("a comment saved without its image data is resent and exported without that mark (#170)", async () => {
  const storage = new Map();
  const first = widgetHarness({ storage, replies: [{ ok: false, status: 500 }] });
  first.init({ persistFeedback: true });
  await first.submit("Saved without its image");
  saveWithoutImageData(storage);

  // Another tab holds the copy saved without the image data.
  const other = widgetHarness({ storage });
  other.init({ persistFeedback: true });
  assert.equal(marks(other.api.getFeedback()[0]), "delivery,screenshot.persistedWithoutDataUrl");
  await retryOf(other);
  assert.equal(other.requests.length, 1);
  const sent = JSON.parse(other.requests[0].body);
  assert.equal(marks(sent), "");
  assert.equal(sent.screenshot.status, "captured");

  const exporting = widgetHarness({ storage });
  exporting.init({ persistFeedback: true, deliveryMode: "download" });
  exportAll(exporting);
  const [exported] = JSON.parse(await exporting.downloads[0].blob.text()).feedback;
  assert.equal(marks(exported), "");
  assert.equal(marks(exporting.api.getFeedback()[0]), "delivery,exported,exportedAt,exportedFileName,screenshot.persistedWithoutDataUrl");
});

test("leaving out the marks does not change the comment held here (#170)", () => {
  const item = {
    id: "pl_a", comment: "c", delivery: { ok: true }, exported: true, previousIds: ["pl_0"],
    screenshot: { status: "captured", persistedWithoutDataUrl: true }
  };
  const wire = toWireFeedback(item);
  assert.equal(marks(wire), "");
  assert.equal([wire.id, wire.comment, wire.screenshot.status].join(","), "pl_a,c,captured");
  assert.equal(marks(item), "delivery,exported,previousIds,screenshot.persistedWithoutDataUrl");
  // A comment without a screenshot, or without the mark on it, is copied as it is.
  assert.equal(toWireFeedback({ id: "pl_b", screenshot: null }).screenshot, null);
  const screenshot = { status: "captured" };
  assert.equal(toWireFeedback({ id: "pl_c", screenshot }).screenshot === screenshot, true);
});
