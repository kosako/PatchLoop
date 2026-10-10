"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Nodes of the fake DOM are never handed to assert: compare strings and booleans.
// Every fake element has the same 200 x 100 box at the top-left, so an element
// the screenshot cannot show always overlaps the captured point (20, 30).

function hint(widget) {
  return widget.document.querySelector("[data-pl-uncaptured-hint]");
}

function addToPage(widget, tag) {
  const node = widget.document.createElement(tag);
  widget.document.body.append(node);
  return node;
}

test("the form asks for what is seen when the spot touches something the screenshot cannot show (#148)", () => {
  const widget = widgetHarness();
  widget.init({ captureScreenshot: true });
  addToPage(widget, "iframe");
  addToPage(widget, "canvas");
  widget.capture();
  assert.equal(hint(widget).hidden, false);
  assert.equal(
    hint(widget).textContent,
    "選んだ場所に、画面画像に写らない要素（iframe、canvas）が重なっているかもしれません。見えている内容をコメントに書き添えてください。"
  );
  const describedBy = widget.document.querySelector("[data-pl-comment-text]").getAttribute("aria-describedby");
  assert.equal(describedBy.split(" ").includes(hint(widget).getAttribute("id")), true);
});

test("more than three names are cut short with など (#148)", () => {
  const widget = widgetHarness();
  widget.init({ captureScreenshot: true });
  for (const tag of ["iframe", "canvas", "video", "embed", "iframe"]) addToPage(widget, tag);
  widget.capture();
  assert.match(hint(widget).textContent, /（iframe、canvas、video など）/);
});

test("no hint without such an element, without screenshots, or while editing (#148)", async () => {
  const plain = widgetHarness();
  plain.init({ captureScreenshot: true });
  plain.capture();
  assert.equal(hint(plain).hidden, true);

  const noScreenshots = widgetHarness();
  noScreenshots.init({ captureScreenshot: false });
  addToPage(noScreenshots, "iframe");
  noScreenshots.capture();
  assert.equal(hint(noScreenshots).hidden, true);

  const editing = widgetHarness();
  editing.init({ captureScreenshot: true });
  await editing.submit("A comment to edit");
  editing.api.setFeedbackMode(false);
  addToPage(editing, "iframe");
  editing.document.querySelector("[data-pl-edit]").click();
  assert.equal(hint(editing).hidden, true);
  assert.equal(hint(editing).textContent, "");
});

test("the hint goes away when the next spot touches nothing the screenshot cannot show (#148)", () => {
  const widget = widgetHarness();
  widget.init({ captureScreenshot: true });
  const frame = addToPage(widget, "iframe");
  widget.capture();
  assert.equal(hint(widget).hidden, false);
  frame.remove();
  widget.capture();
  assert.equal(hint(widget).hidden, true);
});
