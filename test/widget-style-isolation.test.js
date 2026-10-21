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

// Each rule in source order with the at-rules it sits in, outermost first: a
// rule in @supports in @media screen is not under the same conditions as one
// in the same @supports in @media print. Only @media and @supports are read,
// which apply their rules or not and leave the order of the rules as it is.
// Any other at-rule fails: @layer, for one, orders its rules by the layer
// (each @layer without a name is a layer of its own), and !important the
// other way round. A rule nested in a rule fails too, as its outer selector
// would be lost, and so does a comment, an escape or a string of anything but
// words, any of which could hide a brace or a ";" from this reading.
function conditionedRules(css) {
  assert.ok(!css.includes("/*") && !css.includes("\\") && !/["']/.test(css.replace(/"[A-Za-z0-9 -]*"/g, "")), "a comment, an escape or a string is not read");
  const rules = [];
  const preludes = [];
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      const prelude = css.slice(start, index).trim();
      assert.ok(!prelude.startsWith("@") || /^@(media|supports)\b/.test(prelude), `${prelude}: an at-rule other than @media and @supports is not read`);
      preludes.push(prelude);
      start = index + 1;
    } else if (css[index] === "}") {
      const prelude = preludes.pop();
      if (!prelude.startsWith("@")) {
        assert.ok(preludes.every((outer) => outer.startsWith("@")), `${prelude}: a rule nested in a rule is not read`);
        const declarations = css.slice(start, index).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
          const colon = part.indexOf(":");
          return { property: part.slice(0, colon).trim().toLowerCase(), important: /!\s*important$/i.test(part) };
        });
        rules.push({ selectors: selectorList(prelude), declarations, conditions: JSON.stringify(preludes) });
      }
      start = index + 1;
    }
  }
  return rules;
}

// A declaration that a later rule with the same selector and the same
// at-rules overrides, for every selector it is written for, never applies and
// only misleads a reader (#170). A shared rule that one of its selectors
// overrides later (.pl-capture-note, .pl-edit-note) still applies to the
// others, and an !important declaration is not overridden by a later plain one.
// Not read: a later rule of a different selector or a higher specificity, or
// a shorthand (font over font-weight), that also overrides it.
function overriddenDeclarations(css) {
  const rules = conditionedRules(css);
  const overridden = [];
  rules.forEach((rule, index) => {
    const later = rules.slice(index + 1).filter(({ conditions }) => conditions === rule.conditions);
    for (const { property, important } of rule.declarations) {
      const dead = rule.selectors.every((selector) => later.some((other) => other.selectors.includes(selector)
        && other.declarations.some((declaration) => declaration.property === property && (declaration.important || !important))));
      if (dead) overridden.push(`${rule.selectors.join(", ")} { ${property} }`);
    }
  });
  return overridden;
}

test("the check for overridden declarations reads at-rules, selector lists and !important (#170)", () => {
  assert.deepEqual(overriddenDeclarations(".a { color: red; } .a { color: blue; }"), [".a { color }"]);
  // The same @supports in a different @media is under other conditions.
  assert.deepEqual(overriddenDeclarations("@media screen { @supports (display: grid) { .a { font-weight: 900; } } } @media print { @supports (display: grid) { .a { font-weight: 600; } } }"), []);
  assert.deepEqual(overriddenDeclarations("@media screen { @supports (display: grid) { .a { font-weight: 900; } } } @media screen { @supports (display: grid) { .a { font-weight: 600; } } }"), [".a { font-weight }"]);
  assert.deepEqual(overriddenDeclarations(".a { color: red; } @media screen { .a { color: blue; } }"), []);
  // A selector list is overridden only when each of its selectors is.
  assert.deepEqual(overriddenDeclarations(".a, .b { color: red; } .b { color: blue; }"), []);
  assert.deepEqual(overriddenDeclarations(".a, .b { color: red; } .a { color: blue; } .b { color: green; }"), [".a, .b { color }"]);
  assert.deepEqual(overriddenDeclarations(":is(.a, .b) { color: red; } .a { color: blue; }"), []);
  assert.deepEqual(overriddenDeclarations(".a { color: red !important; } .a { color: blue; }"), []);
  assert.deepEqual(overriddenDeclarations(".a { color: red ! important; } .a { color: blue; }"), []);
  assert.deepEqual(overriddenDeclarations(".a { color: red; } .a { color: blue !important; }"), [".a { color }"]);
  assert.throws(() => overriddenDeclarations(".a { .b { color: red; } }"), /nested in a rule/);
  // Two @layer blocks without a name are two layers, where the first one's
  // !important declaration wins: not read.
  assert.throws(() => overriddenDeclarations("@layer { .a { font-weight: 900 !important; } } @layer { .a { font-weight: 600 !important; } }"), /other than @media and @supports/);
  assert.throws(() => overriddenDeclarations("@media screen { @layer base { .a { color: red; } } }"), /other than @media and @supports/);
  assert.throws(() => overriddenDeclarations(".a { color: red; } /* } .a { */ .a { color: blue; }"), /comment, an escape or a string/);
  assert.throws(() => overriddenDeclarations('.a::before { content: ";}"; }'), /comment, an escape or a string/);
});

test("no widget declaration is overridden by a later rule for every selector it is written for (#170)", () => {
  const widget = widgetHarness();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  assert.ok(conditionedRules(css).length > 50);
  assert.deepEqual(overriddenDeclarations(css), []);
});
