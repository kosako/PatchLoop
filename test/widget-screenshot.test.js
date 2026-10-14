"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// byteLength probes window.Blob before constructing a Blob; node has a global
// Blob but no window, so expose it (node --test isolates globals per file).
globalThis.window = { Blob: globalThis.Blob };

const { byteLength, base64Encode, snapshotBodyOffsetStyle } = require("../widget/src/screenshot.js");

test("snapshotBodyOffsetStyle leaves an unscrolled body in place and only keeps it a stacking context (#171)", () => {
  // Nothing needs shifting at scroll 0, including a fixed body that locks
  // scrolling under a modal. isolation keeps the stacking context the
  // transform gave (negative z-index children stay above the body background)
  // without making the body a containing block or touching its z-index.
  for (const bodyStyle of [
    { position: "static", top: "auto", left: "auto" },
    { position: "relative", top: "10px", left: "0px" },
    { position: "fixed", top: "-500px", left: "0px" },
    { position: "absolute", top: "20px", left: "0px" }
  ]) {
    assert.equal(snapshotBodyOffsetStyle(bodyStyle, "block", 0, 0), "isolation:isolate !important;");
  }
});

test("snapshotBodyOffsetStyle shifts a scrolled static body by relative positioning, not a transform (#171)", () => {
  const style = snapshotBodyOffsetStyle({ position: "static", top: "auto", left: "auto" }, "block", 12.4, 499.6);
  // A transform would make the body the containing block of position:fixed
  // descendants and push them out of the snapshot. A z-index that did not
  // apply to the static body is reset so the positioning does not activate it.
  assert.equal(
    style,
    "position:relative !important;top:-500px !important;left:-12px !important;right:auto !important;bottom:auto !important;z-index:auto !important;isolation:isolate !important;"
  );
  // A flex or grid item of html honors its z-index while static, so it is kept.
  assert.doesNotMatch(snapshotBodyOffsetStyle({ position: "static" }, "grid", 0, 100), /z-index/);
  assert.doesNotMatch(snapshotBodyOffsetStyle({ position: "static" }, "inline-flex", 0, 100), /z-index/);
});

test("snapshotBodyOffsetStyle keeps a scrolled relative or sticky body's offsets and z-index (#171)", () => {
  assert.equal(
    snapshotBodyOffsetStyle({ position: "relative", top: "10px", left: "4px" }, "block", 0, 300),
    "position:relative !important;top:-290px !important;left:4px !important;right:auto !important;bottom:auto !important;isolation:isolate !important;"
  );
  // A sticky body's top is a threshold, not an offset.
  assert.match(
    snapshotBodyOffsetStyle({ position: "sticky", top: "0px", left: "auto" }, "block", 0, 100),
    /^position:relative !important;top:-100px !important;left:0px !important;/
  );
  // right is cleared so it cannot cancel the horizontal scroll (RTL pages).
  assert.match(
    snapshotBodyOffsetStyle({ position: "relative", top: "0px", left: "0px", right: "0px" }, "block", -500, 0),
    /left:500px !important;right:auto !important;bottom:auto !important;/
  );
});

test("snapshotBodyOffsetStyle keeps the transform for a scrolled absolute or fixed body (#171)", () => {
  // These bodies can size themselves from left + right or sit in a
  // transformed html, which relative positioning would not reproduce.
  assert.equal(
    snapshotBodyOffsetStyle({ position: "fixed", top: "0px", left: "100px" }, "block", 0, 500),
    "transform:translate(0px, -500px);transform-origin:top left;"
  );
  assert.equal(
    snapshotBodyOffsetStyle({ position: "absolute", top: "20px", left: "0px" }, "block", 7, 100),
    "transform:translate(-7px, -100px);transform-origin:top left;"
  );
});

test("base64Encode matches Buffer's base64 for ascii and multi-byte text", () => {
  for (const value of ["", "hello", "日本語のテキスト✓", '<svg xmlns="http://www.w3.org/2000/svg">&amp;</svg>']) {
    assert.equal(base64Encode(value), Buffer.from(value, "utf8").toString("base64"));
  }
});

test("base64Encode handles inputs larger than its 8192-byte chunks", () => {
  const value = "svg-content-".repeat(3000);
  assert.equal(base64Encode(value), Buffer.from(value, "utf8").toString("base64"));
});

test("byteLength counts utf-8 bytes via Blob", () => {
  assert.equal(byteLength(""), 0);
  assert.equal(byteLength("hello"), 5);
  assert.equal(byteLength("日本語"), Buffer.byteLength("日本語", "utf8"));
});

test("byteLength falls back to the base64 length without Blob", () => {
  const original = globalThis.window.Blob;
  globalThis.window.Blob = undefined;
  try {
    assert.equal(byteLength("日本語"), base64Encode("日本語").length);
  } finally {
    globalThis.window.Blob = original;
  }
});

// --- elements the page does not render (#122) ------------------------------

const { blankUnrenderedElements } = require("../widget/src/screenshot.js");

// A small element tree: enough of the DOM for the walk over document order.
function el(tagName, attributes = {}, children = [], extra = {}) {
  const node = {
    tagName: tagName.toUpperCase(), attributes: { ...attributes }, children, ...extra,
    getAttributeNames() { return Object.keys(this.attributes); },
    removeAttribute(name) { delete this.attributes[name]; },
    replaceChildren() { this.children = []; },
    contains(other) { return other === this || this.children.some((child) => child.contains(other)); }
  };
  return node;
}
function inOrder(root) {
  return root.children.flatMap((child) => [child, ...inOrder(child)]);
}
function clone(node) {
  return el(node.tagName, node.attributes, node.children.map(clone), node.content ? { content: { children: [...node.content.children], replaceChildren() { this.children = []; } } } : {});
}

test("an element the page does not render is emptied in the snapshot, keeping the attributes stylesheets match on", () => {
  const inner = el("span", { "data-note": "kept-data" }, [el("b", {}, [])]);
  const hidden = el("div", { class: "panel", hidden: "", "data-state": "closed", title: "hidden title", "aria-label": "hidden label" }, [inner]);
  const input = el("input", { type: "hidden", name: "form-check", value: "hidden-value" });
  const template = el("template", { id: "row" }, [], { content: { children: [el("p")], replaceChildren() { this.children = []; } } });
  const style = el("style", {}, [el("text")]);
  const shown = el("p", { title: "visible title" }, [el("em")]);
  const body = el("body", {}, [hidden, input, template, style, shown]);
  const copy = clone(body);
  const unrendered = new Set([hidden, inner, input, template, style]);

  blankUnrenderedElements(inOrder(body), inOrder(copy), (node) => unrendered.has(node));
  const [hiddenCopy, inputCopy, templateCopy, styleCopy, shownCopy] = copy.children;
  assert.deepEqual([hiddenCopy.children.length, hiddenCopy.attributes], [0, { class: "panel", hidden: "", "data-state": "closed" }]);
  assert.deepEqual(inputCopy.attributes, { type: "hidden", name: "form-check" });
  assert.deepEqual([templateCopy.children.length, templateCopy.content.children.length, templateCopy.attributes], [0, 0, { id: "row" }]);
  // A <style> in the body still styles the page; what is shown stays as it is.
  assert.equal(styleCopy.children.length, 1);
  assert.deepEqual([shownCopy.children.length, shownCopy.attributes], [1, { title: "visible title" }]);
});

test("a page and clone that do not line up are left alone", () => {
  const body = el("body", {}, [el("div", { title: "t" }, [el("i")])]);
  const copy = clone(body);
  blankUnrenderedElements(inOrder(body), [], () => true);
  blankUnrenderedElements(inOrder(body).slice(1), inOrder(copy), () => true);
  assert.deepEqual([copy.children[0].children.length, copy.children[0].attributes], [1, { title: "t" }]);
});
