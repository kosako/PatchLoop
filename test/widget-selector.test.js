"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { cssEscape, selectorFor, textFor } = require("../widget/src/selector.js");

// Minimal element stand-in: selectorFor only touches tagName, id, classList,
// parentElement, and children.
function el(tagName, { id = "", classes = [] } = {}, children = []) {
  const node = {
    tagName: tagName.toUpperCase(),
    id,
    classList: classes,
    parentElement: null,
    children
  };
  children.forEach((child) => {
    child.parentElement = node;
  });
  return node;
}

test("cssEscape falls back to escaping non-alphanumerics without CSS.escape", () => {
  // Node has no CSS global, so this exercises the fallback branch.
  assert.equal(cssEscape("simple-name_1"), "simple-name_1");
  assert.equal(cssEscape("a.b c"), "a\\.b\\ c");
  assert.equal(cssEscape("1:2"), "1\\:2");
});

test("selectorFor returns body for the root element and missing elements", () => {
  const body = el("body");
  assert.equal(selectorFor(body, body), "body");
  assert.equal(selectorFor(null, body), "body");
});

test("selectorFor prefers an id selector", () => {
  const target = el("div", { id: "hero" });
  const body = el("body", {}, [target]);
  assert.equal(selectorFor(target, body), "#hero");
  const weird = el("div", { id: "a:b" });
  el("body", {}, [weird]);
  assert.equal(selectorFor(weird, body), "#a\\:b");
});

test("selectorFor builds a path with at most two classes per element", () => {
  const target = el("span", { classes: ["price", "bold", "extra"] });
  const section = el("section", { classes: ["hero"] }, [target]);
  const body = el("body", {}, [section]);
  assert.equal(selectorFor(target, body), "section.hero > span.price.bold");
});

test("selectorFor adds nth-of-type only when same-tag siblings exist", () => {
  const first = el("li");
  const second = el("li");
  const other = el("p");
  const list = el("ul", {}, [first, other, second]);
  const body = el("body", {}, [list]);
  assert.equal(selectorFor(second, body), "ul > li:nth-of-type(2)");
  assert.equal(selectorFor(other, body), "ul > p");
});

test("selectorFor stops after four path segments", () => {
  let current = el("em");
  const target = current;
  for (const tag of ["i", "b", "u", "s", "q"]) {
    current = el(tag, {}, [current]);
  }
  const body = el("body", {}, [current]);
  assert.equal(selectorFor(target, body), "u > b > i > em");
});

test("textFor collapses whitespace and truncates to 140 characters", () => {
  assert.equal(textFor({ textContent: "  hello \n  world\t " }), "hello world");
  assert.equal(textFor(null), "");
  assert.equal(textFor({ textContent: "x".repeat(200) }).length, 140);
});
