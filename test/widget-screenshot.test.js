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

const { blankText, blankUnrenderedElements, browserTextDirection, clearTemplateContents, removeComments } = require("../widget/src/screenshot.js");

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// A small node tree: enough of the DOM for the walk over document order.
function adopt(parent, children) {
  children.forEach((child) => {
    child.remove = function () { parent.childNodes = parent.childNodes.filter((node) => node !== this); };
  });
  return children;
}
function text(data) { return { nodeType: 3, data }; }
function comment(data) { return { nodeType: 8, data }; }
function el(tagName, attributes = {}, children = [], { namespaceURI = HTML_NS, content = null } = {}) {
  const node = {
    nodeType: 1, tagName: namespaceURI === HTML_NS ? tagName.toUpperCase() : tagName, namespaceURI, attributes: { ...attributes }, content,
    getAttributeNames() { return Object.keys(this.attributes); },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    contains(other) { return other === this || this.childNodes.some((child) => child.nodeType === 1 && child.contains(other)); }
  };
  node.childNodes = adopt(node, children);
  return node;
}
function fragment(children) {
  return { childNodes: children, replaceChildren() { this.childNodes = []; } };
}
function copyOf(node) {
  if (node.nodeType !== 1) return { ...node };
  return el(node.tagName, node.attributes, node.childNodes.map(copyOf), { namespaceURI: node.namespaceURI, content: node.content && fragment([...node.content.childNodes]) });
}
const elementsOf = (root) => root.childNodes.filter((node) => node.nodeType === 1).flatMap((child) => [child, ...elementsOf(child)]);
const texts = (node) => node.childNodes.flatMap((child) => child.nodeType === 3 ? [child.data] : child.nodeType === 1 ? texts(child) : []);
const kinds = (node) => node.childNodes.map((child) => child.nodeType === 1 ? child.tagName : child.nodeType);

function snapshot(body, unrendered) {
  const copy = copyOf(body);
  blankUnrenderedElements(elementsOf(body), elementsOf(copy), (node) => unrendered.has(node));
  return copy;
}

test("an element the page does not render keeps its elements and attributes, but no text, content attributes or comments", () => {
  const inner = el("span", { "data-note": "kept", title: "inner title" }, [text("hidden inner text")]);
  const hidden = el("div", { class: "panel", hidden: "", "data-state": "closed", title: "hidden title", "aria-label": "hidden label" },
    [text("hidden text"), comment("hidden comment"), inner, el("i")]);
  const shown = el("p", { title: "visible title" }, [text("visible text")]);
  const body = el("body", {}, [hidden, shown]);
  const copy = snapshot(body, new Set([hidden, inner]));
  const [hiddenCopy, shownCopy] = copy.childNodes;

  // Every element stays (selectors such as :nth-child, + and :has() match as
  // before), each text keeps being a text (:empty too), and the attributes
  // stay present, empty when they carry content.
  assert.deepEqual(kinds(hiddenCopy), [3, "SPAN", "I"]);
  assert.deepEqual(texts(hiddenCopy), ["\u200e", "\u200e"]);
  assert.deepEqual(hiddenCopy.attributes, { class: "panel", hidden: "", "data-state": "closed", title: "", "aria-label": "" });
  assert.deepEqual(hiddenCopy.childNodes[1].attributes, { "data-note": "kept", title: "" });
  assert.deepEqual(hiddenCopy.childNodes[2].childNodes, []);
  assert.deepEqual([shownCopy.attributes, texts(shownCopy)], [{ title: "visible title" }, ["visible text"]]);
});

test("content kept in attributes goes too: input values, srcdoc, object data, links", () => {
  const input = el("input", { type: "hidden", name: "form-check", value: "hidden-value" });
  const frame = el("iframe", { hidden: "", srcdoc: "<p>inline document</p>" });
  const object = el("object", { data: "https://example.test/file.pdf", type: "application/pdf" });
  const link = el("a", { href: "https://example.test/path" }, [text("link")]);
  const wrapper = el("div", { style: "display:none" }, [object, link]);
  const copy = snapshot(el("body", {}, [input, frame, wrapper]), new Set([input, frame, wrapper, object, link]));
  const [inputCopy, frameCopy, wrapperCopy] = copy.childNodes;
  assert.deepEqual(inputCopy.attributes, { type: "hidden", name: "form-check", value: "" });
  assert.deepEqual(frameCopy.attributes, { hidden: "", srcdoc: "" });
  assert.deepEqual(wrapperCopy.childNodes.map((child) => child.attributes), [{ data: "", type: "application/pdf" }, { href: "" }]);
});

test("hidden <style>, <link>, <option> and <optgroup> stay as the page shows them; a hidden <template> keeps its attributes", () => {
  const template = el("template", { id: "row" }, [], { content: fragment([el("p", {}, [text("template text")])]) });
  const style = el("style", {}, [text(".x { color: red }")]);
  const placeholder = el("option", { hidden: "", selected: "", value: "" }, [text("Choose one")]);
  const group = el("optgroup", { hidden: "", label: "Group" }, [el("option", {}, [text("In the group")])]);
  const select = el("select", {}, [placeholder, group, el("option", { value: "jp" }, [text("Japan")])]);
  const copy = snapshot(el("body", {}, [template, style, select]), new Set([template, style, placeholder, group]));
  const [templateCopy, styleCopy, selectCopy] = copy.childNodes;
  assert.deepEqual(templateCopy.attributes, { id: "row" });
  assert.deepEqual(texts(styleCopy), [".x { color: red }"]);
  assert.deepEqual(texts(selectCopy), ["Choose one", "In the group", "Japan"]);
  assert.deepEqual(selectCopy.childNodes[0].attributes, { hidden: "", selected: "", value: "" });
});

test("inside a hidden element, <style> and <link> stay: they style the page", () => {
  const style = el("style", {}, [text(".x { color: red }")]);
  const link = el("link", { rel: "stylesheet", href: "/late.css" });
  const wrapper = el("div", { hidden: "" }, [text("wrapper text"), style, link]);
  const copy = snapshot(el("body", {}, [wrapper]), new Set([wrapper, style, link]));
  const [, styleCopy, linkCopy] = copy.childNodes[0].childNodes;
  assert.deepEqual(texts(styleCopy), [".x { color: red }"]);
  assert.deepEqual(linkCopy.attributes, { rel: "stylesheet", href: "/late.css" });
});

test("form controls keep what decides the form's validity: values, placeholders, textarea and select contents", () => {
  const field = el("input", { type: "text", required: "", value: "ok", placeholder: "Name", title: "field title" });
  const token = el("input", { type: "hidden", value: "hidden-value" });
  const note = el("textarea", { required: "" }, [text("typed note")]);
  const choice = el("select", { required: "" }, [el("option", { value: "jp" }, [text("Japan")])]);
  const form = el("form", { hidden: "" }, [field, token, note, choice, el("button", {}, [text("Send")])]);
  const copy = snapshot(el("body", {}, [form]), new Set([form, field, token, note, choice]));
  const [fieldCopy, tokenCopy, noteCopy, choiceCopy, buttonCopy] = copy.childNodes[0].childNodes;
  assert.deepEqual(fieldCopy.attributes, { type: "text", required: "", value: "ok", placeholder: "Name", title: "" });
  assert.deepEqual(tokenCopy.attributes, { type: "hidden", value: "" });
  assert.deepEqual([texts(noteCopy), texts(choiceCopy), choiceCopy.childNodes[0].attributes], [["typed note"], ["Japan"], { value: "jp" }]);
  assert.deepEqual(texts(buttonCopy), ["\u200e"]);
});

test("SVG stays as it is, hidden or inside a hidden element: <use> may draw it elsewhere", () => {
  const sprite = el("svg", { style: "display:none" }, [el("symbol", { id: "icon" }, [el("text", {}, [text("icon label")], { namespaceURI: SVG_NS })], { namespaceURI: SVG_NS })], { namespaceURI: SVG_NS });
  const nested = el("svg", {}, [el("use", { href: "#icon" }, [], { namespaceURI: SVG_NS })], { namespaceURI: SVG_NS });
  const wrapper = el("div", { hidden: "" }, [text("wrapper text"), nested]);
  const copy = snapshot(el("body", {}, [sprite, wrapper]), new Set([sprite, wrapper, nested]));
  const [spriteCopy, wrapperCopy] = copy.childNodes;
  assert.deepEqual(texts(spriteCopy), ["icon label"]);
  assert.deepEqual([texts(wrapperCopy), wrapperCopy.childNodes[1].childNodes[0].attributes], [["\u200e"], { href: "#icon" }]);
});

test("every <template>'s content goes, also inside a kept <select> and outside hidden elements", () => {
  const inSelect = el("template", {}, [], { content: fragment([el("option", { value: "inner" }, [text("template option")])]) });
  const shown = el("template", { id: "shown" }, [], { content: fragment([el("p", {}, [text("template text")])]) });
  const wrapper = el("div", { hidden: "" }, [el("select", {}, [inSelect, el("option", {}, [text("Plain")])])]);
  const body = el("body", {}, [wrapper, shown]);
  const copy = snapshot(body, new Set([wrapper, shown]));
  const templates = elementsOf(copy).filter((node) => node.tagName === "TEMPLATE");
  clearTemplateContents(templates);
  assert.deepEqual(templates.map((template) => template.content.childNodes), [[], []]);
  assert.deepEqual(texts(copy.childNodes[0]), ["Plain"]);
});

test("a hidden text keeps only the direction of its first strong character, which dir=\"auto\" goes by", () => {
  assert.equal(blankText("שלום world"), "\u200f");
  assert.equal(blankText("123 مرحبا"), "\u200f");
  assert.equal(blankText("Hello שלום"), "\u200e");
  assert.equal(blankText("日本語"), "\u200e");
  for (const neutral of ["123", "  \n ", "!?-"]) assert.equal(blankText(neutral), " ");
  const hidden = el("span", { hidden: "" }, [text("א")]);
  const box = el("div", { dir: "auto" }, [hidden, el("span", {}, [text("A")])]);
  const copy = snapshot(el("body", {}, [box]), new Set([hidden]));
  assert.deepEqual(texts(copy.childNodes[0]), ["\u200f", "A"]);
});

test("the direction comes from the browser's own rules when it has :dir(), the approximation otherwise", () => {
  // A stand-in for the browser: only "R" and "L" are strong here.
  const probe = {
    setAttribute() {}, textContent: "",
    matches(selector) {
      assert.equal(selector, ":dir(rtl)");
      return /^[^RL]*R/.test(this.textContent.replace(/\u05D0/g, "R"));
    }
  };
  const direction = browserTextDirection({ createElement: () => probe });
  assert.deepEqual(["R first", "L first", "no strong 123"].map(direction), ["rtl", "ltr", null]);
  assert.deepEqual(["R first", "L first", "no strong 123"].map((data) => blankText(data, direction)), ["\u200f", "\u200e", " "]);
  const hidden = el("span", { hidden: "" }, [text("R hidden")]);
  const body = el("body", {}, [el("div", { dir: "auto" }, [hidden])]);
  const copy = copyOf(body);
  blankUnrenderedElements(elementsOf(body), elementsOf(copy), (node) => node === hidden, direction);
  assert.deepEqual(texts(copy), ["\u200f"]);
  // Without :dir() (an older browser): by script.
  const old = browserTextDirection({ createElement: () => ({ setAttribute() {}, matches() { throw new SyntaxError("unknown pseudo-class"); } }) });
  assert.deepEqual(["\u0640مرحبا", "Ⅰ", "123"].map(old), ["rtl", "ltr", null]);
});

test("comments go from the whole snapshot", () => {
  const body = el("body", {}, [comment("top"), el("p", {}, [text("shown"), comment("inside")])]);
  removeComments(body);
  assert.deepEqual([kinds(body), kinds(body.childNodes[0])], [["P"], [3]]);
});

test("a page and clone that do not line up are left alone", () => {
  const body = el("body", {}, [el("div", { title: "t" }, [text("kept")])]);
  const copy = copyOf(body);
  blankUnrenderedElements(elementsOf(body), [], () => true);
  blankUnrenderedElements(elementsOf(body).slice(1), elementsOf(copy), () => true);
  assert.deepEqual([copy.childNodes[0].attributes, texts(copy)], [{ title: "t" }, ["kept"]]);
});
