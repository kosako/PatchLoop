"use strict";

// The download-mode export takes the comments saved on this device by every
// page of the project / demo (#197), so a page the reviewer did not export
// from loses nothing.

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

const BASE = "https://demo.example";

function openPage(w, path, options = {}) {
  w.api.destroy();
  w.window.location.href = `${BASE}${path}`;
  w.init({ persistFeedback: true, deliveryMode: "download", ...options });
}

const button = (w) => w.document.querySelector("[data-pl-download-all]");
const again = (w) => w.document.querySelector("[data-pl-download-again]");
const note = (w) => w.document.querySelector("[data-pl-other-pages]");
const bundleAt = async (w, index) => JSON.parse(await w.downloads[index].blob.text());

function storageKeyFor(w, path) {
  const storage = w.window.localStorage;
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .find((key) => key.endsWith(`${JSON.stringify(`${BASE}${path}`)}]`));
}

test("the export takes the unexported comments of the demo's other pages and marks them on those pages", async () => {
  const w = widgetHarness();
  openPage(w, "/a");
  await w.submit("On A");
  openPage(w, "/a", { demoId: "other-demo" });
  await w.submit("Another demo");
  openPage(w, "/b");
  await w.submit("On B");

  assert.equal(button(w).textContent, "未送信を書き出す（2）");
  assert.equal(note(w).hidden, false);
  assert.match(note(w).textContent, /ほかのページに未書き出しのコメントが 1 件/);

  button(w).click();
  const bundle = await bundleAt(w, 0);
  assert.deepEqual(bundle.feedback.map((item) => [item.comment, item.page.url]), [["On B", `${BASE}/b`], ["On A", `${BASE}/a`]]);
  assert.equal(button(w).textContent, "すべて書き出し済み");
  assert.equal(note(w).hidden, true);

  openPage(w, "/a");
  assert.equal(w.api.getFeedback()[0].exported, true);
  assert.equal(w.api.getFeedback()[0].exportedFileName, w.downloads[0].name);
  assert.equal(button(w).textContent, "すべて書き出し済み");
  openPage(w, "/a", { demoId: "other-demo" });
  assert.equal(w.api.getFeedback()[0].exported, undefined);
  assert.equal(button(w).textContent, "未送信を書き出す（1）");
});

test("downloading everything again takes every page's comments, from a page with none of its own", async () => {
  const w = widgetHarness();
  openPage(w, "/a");
  await w.submit("On A");
  openPage(w, "/b");
  await w.submit("On B");
  button(w).click();

  openPage(w, "/c");
  assert.equal(again(w).hidden, false);
  assert.equal(button(w).disabled, true);
  again(w).click();
  const bundle = await bundleAt(w, 1);
  assert.deepEqual(bundle.feedback.map((item) => item.comment).sort(), ["On A", "On B"]);
});

test("the other pages' URLs go out under the current keepQueryParams and are saved back trimmed", async () => {
  const w = widgetHarness();
  openPage(w, "/a?step=2&token=abc", { keepQueryParams: ["step", "token"] });
  await w.submit("On A");
  openPage(w, "/b", { keepQueryParams: ["step"] });
  await w.submit("On B");
  button(w).click();

  const bundle = await bundleAt(w, 0);
  assert.equal(bundle.feedback.find((item) => item.comment === "On A").page.url, `${BASE}/a?step=2`);
  const saved = JSON.parse(w.window.localStorage.getItem(storageKeyFor(w, "/a")));
  assert.equal(saved.feedback[0].page.url, `${BASE}/a?step=2`);
  assert.equal(saved.feedback[0].exported, true);
});

test("a comment saved by another tab on another page shows up in the count", async () => {
  const w = widgetHarness();
  openPage(w, "/a");
  await w.submit("On A");
  const key = storageKeyFor(w, "/a");
  const value = w.window.localStorage.getItem(key);
  w.window.localStorage.removeItem(key);

  openPage(w, "/b");
  assert.equal(button(w).textContent, "すべて書き出し済み");
  w.window.localStorage.setItem(key, value);
  w.window.emit("storage", { key });
  assert.equal(button(w).textContent, "未送信を書き出す（1）");
  assert.equal(note(w).hidden, false);
});

test("a broken entry of another page is skipped with a warning and the rest is exported", async () => {
  const w = widgetHarness();
  w.window.localStorage.setItem(`patchloop:feedback:${JSON.stringify(["local-demo", "plain-html", `${BASE}/x`])}`, "{broken");
  openPage(w, "/b");
  await w.submit("On B");
  button(w).click();

  assert.deepEqual((await bundleAt(w, 0)).feedback.map((item) => item.comment), ["On B"]);
  assert.ok(w.warnings.some(([message]) => String(message).includes("saved feedback of another page ignored")));
});

test("when another page's marks cannot be saved, its comment stays unexported for the next export", async () => {
  const w = widgetHarness();
  openPage(w, "/a");
  await w.submit("On A");
  openPage(w, "/b");
  await w.submit("On B");
  const keyA = storageKeyFor(w, "/a");
  const setItem = w.window.localStorage.setItem;
  w.window.localStorage.setItem = (key, value) => {
    if (key === keyA) throw new Error("QuotaExceededError");
    return setItem(key, value);
  };

  button(w).click();
  assert.equal((await bundleAt(w, 0)).feedback.length, 2);
  assert.ok(w.warnings.some(([message]) => String(message).includes("unable to save another page's feedback")));
  assert.equal(button(w).textContent, "未送信を書き出す（1）");
  assert.match(note(w).textContent, /1 件/);
});

test("the other pages are not read outside download mode", async () => {
  const w = widgetHarness();
  openPage(w, "/a");
  await w.submit("On A");
  openPage(w, "/b", { deliveryMode: "none" });
  assert.equal(button(w).hidden, true);
  assert.equal(again(w).hidden, true);
  assert.equal(note(w).hidden, true);
});
