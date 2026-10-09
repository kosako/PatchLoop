"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

// Innermost "selector { declarations }" pairs; @media wrappers drop out
// because their selector text cannot contain a brace.
function styleRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2].trim() }));
}

// Splits a selector list on top-level commas (not the ones inside :is()).
function selectorList(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

test("widget styles start with the host-page reset and every later rule outranks it", () => {
  const widget = widgetHarness();
  widget.init();
  const rules = styleRules(widget.document.querySelector("[data-patchloop-style]").textContent);
  const [initial, revertDescendants, revertPseudo, ...widgetRules] = rules;

  // Top-level widget nodes: initial values, so page typography on html/body
  // is not inherited; the lang-derived locale is kept for Japanese glyphs.
  assert.deepEqual(selectorList(initial.selector), [".pl-root", "[data-patchloop-pin]", "[data-patchloop-area]", "[data-patchloop-selection]"]);
  assert.equal(initial.body, "all: initial; -webkit-locale: inherit;");
  // Their descendants and pseudo-elements: browser defaults, so page rules on
  // header / section / button / p / * fill nothing in.
  assert.deepEqual(selectorList(revertDescendants.selector), [".pl-root *", "[data-patchloop-area] *"]);
  assert.equal(revertDescendants.body, "all: revert;");
  // Pseudo-elements in their own rule: a browser without :is() drops only
  // this rule, not the descendant reset above.
  const pseudo = selectorList(revertPseudo.selector);
  assert.ok(pseudo.some((selector) => selector.endsWith("::before")) && pseudo.some((selector) => selector.endsWith("::after")));
  assert.equal(revertPseudo.body, "all: revert;");

  // The reset is (0,1,0) and comes first. A widget rule wins over it only if
  // its selector carries at least a class or an attribute, so a bare element
  // selector (textarea { ... }) added later would be silently reset away.
  assert.ok(widgetRules.length > 50);
  for (const rule of widgetRules) {
    assert.doesNotMatch(rule.body, /(^|;)\s*all\s*:/, `${rule.selector} must not reset with all:`);
    for (const selector of selectorList(rule.selector)) {
      assert.match(selector, /^(\.pl-[\w-]+|\[data-patchloop-[\w-]+\])/, `${selector} must start with a widget class or data-patchloop attribute`);
    }
  }
});
