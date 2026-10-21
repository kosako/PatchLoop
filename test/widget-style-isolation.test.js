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
// other way round. Anything nested in a style rule (a rule, @media or
// @supports) fails too, as its outer selector would be lost, and so does a
// comment, an escape or a string of anything but words, any of which could
// hide a brace or a ";" from this reading. A declaration without a colon,
// text before a rule that is not its selector, a declaration put in an
// at-rule outside a rule, an unmatched } or ) and a rule left open fail as
// well. Declarations are split at the ";" outside parentheses, so one inside
// url() or another function stays in its declaration.
// Known limit: the CSS is not cut into tokens as a browser cuts it (a space
// CSS does not count as one, such as U+00A0, is read as one). The check
// guards the CSS this widget is written in, not CSS made to slip past it.
function conditionedRules(css) {
  assert.ok(!css.includes("/*") && !css.includes("\\") && !/["']/.test(css.replace(/"[A-Za-z0-9 -]*"/g, "")), "a comment, an escape or a string is not read");
  const rules = [];
  const preludes = [];
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      const prelude = css.slice(start, index).trim();
      assert.ok(prelude && !prelude.includes(";"), `${prelude}: not a selector or an at-rule alone, not read`);
      assert.ok(!prelude.startsWith("@") || /^@(media|supports)\b/.test(prelude), `${prelude}: an at-rule other than @media and @supports is not read`);
      assert.ok(preludes.every((outer) => outer.startsWith("@")), `${prelude}: nested in a rule, not read`);
      preludes.push(prelude);
      start = index + 1;
    } else if (css[index] === "}") {
      assert.ok(preludes.length > 0, "an unmatched } is not read");
      const prelude = preludes.pop();
      const body = css.slice(start, index);
      if (prelude.startsWith("@")) {
        assert.ok(!body.trim(), `${prelude} { ${body.trim()} }: a declaration outside a rule is not read`);
      } else {
        const declarations = declarationsOf(prelude, body).map((part) => {
          const colon = part.indexOf(":");
          assert.ok(colon > 0, `${prelude} { ${part} }: a declaration without a colon is not read`);
          return { property: part.slice(0, colon).trim().toLowerCase(), important: /!\s*important$/i.test(part) };
        });
        rules.push({ selectors: selectorList(prelude), declarations, conditions: JSON.stringify(preludes) });
      }
      start = index + 1;
    }
  }
  assert.ok(preludes.length === 0 && !css.slice(start).trim(), "a rule left open is not read");
  return rules;
}

// The declarations of a rule's body, split at each ";" outside parentheses.
function declarationsOf(prelude, body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    assert.ok(depth >= 0, `${prelude} { ${body.trim()} }: an unmatched ) is not read`);
    if (char === ";" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  assert.ok(depth === 0, `${prelude} { ${body.trim()} }: an unmatched ( is not read`);
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// The widget's CSS sets a property for a selector once (#170): a later rule
// under the same at-rules that sets it again, for every selector the earlier
// rule is written for, leaves the earlier one to apply only where a browser
// does not read the later value, and a reader takes it for one that applies.
// A fallback for such a browser goes in the same rule as the value it stands
// in for (width: 320px; width: -moz-available;), which this does not compare.
// A shared rule that one of its selectors sets again later (.pl-capture-note,
// .pl-edit-note) still applies to the others, and an !important declaration is
// not overridden by a later plain one.
// Not read: a later rule of a different selector or a higher specificity, or
// a shorthand (font over font-weight), that also sets it.
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
  // A fallback is written in the rule of the value it stands in for, not in an
  // earlier rule, where it reads as one that applies.
  assert.deepEqual(overriddenDeclarations(".a { width: 320px; width: -moz-available; }"), []);
  assert.deepEqual(overriddenDeclarations(".a { width: 320px; } .a { width: -moz-available; }"), [".a { width }"]);
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
  assert.throws(() => overriddenDeclarations(".a { @media screen { width: 320px; } } @media screen { .a { width: 400px; } }"), /nested in a rule/);
  assert.throws(() => overriddenDeclarations(".a { @supports (display: grid) { width: 320px; } }"), /nested in a rule/);
  assert.throws(() => overriddenDeclarations("@media screen { width: 320px; .a { width: 400px; } }"), /not a selector or an at-rule alone/);
  assert.throws(() => overriddenDeclarations("@media screen { width: 320px; }"), /declaration outside a rule/);
  assert.throws(() => overriddenDeclarations(".a { color red; }"), /without a colon/);
  assert.throws(() => overriddenDeclarations(".a { color: red; } }"), /unmatched }/);
  assert.throws(() => overriddenDeclarations(".a { color: red; } .a { color: blue;"), /left open/);
  // A ";" or an !important inside url() belongs to its declaration.
  assert.deepEqual(overriddenDeclarations(".a { background-image: url(./icon.svg;width:320px); } .a { width: 400px; }"), []);
  assert.deepEqual(overriddenDeclarations(".a { background-image: url(./icon.svg!important;x:y); } .a { background-image: none; }"), [".a { background-image }"]);
  assert.throws(() => overriddenDeclarations(".a { width: calc(1px + 2px; }"), /unmatched \(/);
  assert.throws(() => overriddenDeclarations(".a { width: 1px); }"), /unmatched \)/);
  // Two @layer blocks without a name are two layers, where the first one's
  // !important declaration wins: not read.
  assert.throws(() => overriddenDeclarations("@layer { .a { font-weight: 900 !important; } } @layer { .a { font-weight: 600 !important; } }"), /other than @media and @supports/);
  assert.throws(() => overriddenDeclarations("@media screen { @layer base { .a { color: red; } } }"), /other than @media and @supports/);
  assert.throws(() => overriddenDeclarations(".a { color: red; } /* } .a { */ .a { color: blue; }"), /comment, an escape or a string/);
  assert.throws(() => overriddenDeclarations('.a::before { content: ";}"; }'), /comment, an escape or a string/);
});

test("no widget rule sets a property again that an earlier rule sets for each of its selectors (#170)", () => {
  const widget = widgetHarness();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  assert.ok(conditionedRules(css).length > 50);
  assert.deepEqual(overriddenDeclarations(css), []);
});

// The widget's colors are custom properties set on its top-level nodes (#170),
// which every other widget node descends from. The two classes the widget puts
// on page elements (the target's highlight, and capture mode on the root
// element) are outside those nodes, where a var() would find no value.
test("every var() in the widget styles names a color set on the widget's top-level nodes, and only widget nodes use one (#170)", () => {
  const widget = widgetHarness();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  const tokenRules = styleRules(css).filter(({ body }) => /(^|;)\s*--/.test(body));
  assert.equal(tokenRules.length, 1);
  const [tokenRule] = tokenRules;
  assert.deepEqual(selectorList(tokenRule.selector), [".pl-root", "[data-patchloop-pin]", "[data-patchloop-area]", "[data-patchloop-selection]"]);
  const tokens = new Map(tokenRule.body.split(";").map((part) => part.trim()).filter(Boolean).map((part) => part.split(":").map((value) => value.trim())));
  assert.deepEqual([...tokens.keys()], ["--pl-ink", "--pl-muted", "--pl-line", "--pl-accent", "--pl-danger"]);

  for (const { selector, body } of styleRules(css)) {
    if (selector === tokenRule.selector && body === tokenRule.body) continue;
    for (const [, name] of body.matchAll(/var\(([^)]*)\)/g)) assert.ok(tokens.has(name), `${selector}: var(${name}) names no widget color`);
    // A color the tokens hold is written as its var(), so a change of it is made in one place.
    for (const value of tokens.values()) assert.ok(!new RegExp(`${value}(?![\\da-f])`, "i").test(body), `${selector}: ${value} written out instead of its var()`);
    if (body.includes("var(")) {
      for (const subject of selectorList(selector)) {
        assert.ok(!/^\.pl-target-highlight\b/.test(subject) && !/^\.pl-feedback-active(\s+\*)?$/.test(subject), `${subject}: a page element, where the widget's colors are not set`);
      }
    }
  }
});
