"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { widgetHarness } = require("../test-support/widget-dom.js");

test("point and area markers have descriptive names and focusable labels", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  await widget.submit("Area comment", { area: true });
  const point = widget.document.querySelector("[data-patchloop-pin]");
  const area = widget.document.querySelector("[data-patchloop-area]").querySelector("button");
  assert.equal(point.tagName, "BUTTON");
  assert.equal(point.getAttribute("aria-label"), "点のフィードバック 1: Point comment");
  assert.ok(area, "area marker must have a native keyboard-focusable label");
  assert.equal(area.type, "button");
  assert.equal(area.getAttribute("aria-label"), "範囲のフィードバック 2: Area comment");
});

test("marker focus displays its tooltip, which stays through mouseleave and closes with Escape or blur", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Keyboard-readable comment");
  widget.api.setFeedbackMode(false);
  const point = widget.document.querySelector("[data-patchloop-pin]");
  const tooltip = widget.document.querySelector("[data-pl-tooltip]");
  point.focus();
  assert.equal(tooltip.getAttribute("role"), "tooltip");
  assert.equal(point.getAttribute("aria-describedby"), tooltip.getAttribute("id"));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, "Reviewer\nKeyboard-readable comment");
  assert.match(tooltip.style.left, /^\d+px$/);
  assert.match(tooltip.style.top, /^\d+px$/);
  point.emit("mouseleave");
  assert.equal(tooltip.hidden, false);
  point.emit("keydown", { key: "Escape" });
  assert.equal(tooltip.hidden, true);
  assert.equal(widget.document.activeElement, point);
  widget.document.querySelector("[data-pl-collapse]").focus();
  point.focus();
  assert.equal(tooltip.hidden, false);
  widget.document.querySelector("[data-pl-collapse]").focus();
  assert.equal(tooltip.hidden, true);
});

test("Escape cancels a pending comment and restores focus to the previous control", () => {
  const widget = widgetHarness();
  widget.init();
  const trigger = widget.document.querySelector("[data-pl-collapse]");
  trigger.focus();
  widget.capture();
  const form = widget.document.querySelector("[data-pl-comment]");
  assert.equal(widget.document.activeElement, form.querySelector("[data-pl-comment-text]"));
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 1);
  form.emit("keydown", { key: "Escape" });
  assert.equal(form.hidden, true);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 0);
  assert.equal(widget.api.getFeedback().length, 0);
  assert.equal(widget.requests.length, 0);
  assert.equal(widget.document.activeElement, trigger);
});

test("Escape during IME composition does not cancel a comment", () => {
  const widget = widgetHarness();
  widget.init();
  widget.capture();
  const form = widget.document.querySelector("[data-pl-comment]");
  form.emit("keydown", { key: "Escape", isComposing: true });
  assert.equal(form.hidden, false);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 1);
});

test("canceling an edit preserves the comment and returns focus to its edit button", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Original comment");
  const edit = widget.document.querySelector("[data-pl-edit]");
  edit.focus();
  edit.click();
  const form = widget.document.querySelector("[data-pl-comment]");
  form.querySelector("[data-pl-comment-text]").value = "Canceled edit";
  form.emit("keydown", { key: "Escape" });
  assert.equal(widget.api.getFeedback()[0].comment, "Original comment");
  assert.equal(widget.document.activeElement, edit);
  assert.equal(form.hidden, true);
});

test("editing and deleting comments refresh marker names and restore focus after rerender", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("First comment");
  await widget.submit("Second comment");
  const edit = widget.document.querySelector("[data-pl-edit]");
  edit.focus();
  edit.click();
  await widget.submit("Updated comment", { captureTarget: false });
  const points = widget.document.querySelectorAll("[data-patchloop-pin]");
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 2: Updated comment");
  assert.equal(widget.document.activeElement, widget.document.querySelector("[data-pl-collapse]"));
  const oldestCard = widget.document.querySelectorAll("[data-feedback-id]")[1];
  oldestCard.querySelector("[data-pl-delete]").click();
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 1: Updated comment");
});

for (const remaining of [0, 1]) {
  test(`deleting the edited comment restores connected focus with ${remaining} comments remaining`, async () => {
    const widget = widgetHarness();
    widget.init();
    if (remaining) await widget.submit("Keep this comment");
    await widget.submit("Delete this comment");
    const list = widget.document.querySelector("[data-pl-list]");
    const card = list.querySelector("[data-feedback-id]");
    const edit = card.querySelector("[data-pl-edit]");
    edit.focus();
    edit.click();
    const form = widget.document.querySelector("[data-pl-comment]");
    assert.equal(form.hidden, false);
    const remove = card.querySelector("[data-pl-delete]");
    remove.focus();
    remove.click();
    assert.equal(form.hidden, true);
    assert.equal(widget.api.getFeedback().length, remaining);
    assert.equal(widget.api.getFeedback().some((item) => item.id === card.dataset.feedbackId), false);
    assert.equal(widget.document.activeElement, widget.document.querySelector("[data-pl-collapse]"));
    assert.equal(widget.document.activeElement.isConnected, true);
    assert.equal(widget.requests.length, remaining + 1);
  });
}

test("restored markers retain accessible names and focus tooltips", async () => {
  const widget = widgetHarness();
  widget.init({ persistFeedback: true });
  await widget.submit("Persisted comment", { area: true });
  widget.api.destroy();
  widget.init({ persistFeedback: true });
  const label = widget.document.querySelector("[data-patchloop-area]").querySelector("button");
  assert.equal(label.getAttribute("aria-label"), "範囲のフィードバック 1: Persisted comment");
  label.focus();
  assert.equal(widget.document.querySelector("[data-pl-tooltip]").hidden, false);
});

function rgb(hex) {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((char) => char + char).join("") : digits;
  assert.match(full, /^[\da-f]{6}$/i);
  return full.match(/../g).map((value) => parseInt(value, 16) / 255);
}

function luminance(color) {
  const [red, green, blue] = color.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// The widget's rules in source order, each with the at-rule it sits in (null
// outside any) and the properties marked !important. Only the plain CSS this
// widget writes is read: an escape, a comment, a string of anything but words,
// a declaration that is not "property: value", an unmatched brace or a rule
// left open could each hide a declaration from the reading, so each fails
// instead of being read differently from the browser.
// Known limit (#209, review round 6): declarations are split at every ";" and
// trimmed as JavaScript trims, not cut into CSS tokens, so a ";" inside
// parentheses or brackets, or a space CSS does not count as one (U+00A0), is
// still read differently from the browser. The check guards the CSS this
// widget is written in, not CSS made to slip past it.
function styleRules(widget) {
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  assert.ok(!css.includes("\\"), "an escape in the widget CSS is not read by the contrast check");
  assert.ok(!css.includes("/*"), "a comment in the widget CSS is not read by the contrast check");
  assert.ok(!/["']/.test(css.replace(/"[A-Za-z0-9 -]*"/g, "")), "a string other than plain words in the widget CSS is not read by the contrast check");
  const rules = [];
  const preludes = [];
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === "{") {
      const prelude = css.slice(start, index).trim();
      // Not read: a rule nested in a rule (the outer declarations around it
      // would be lost), and a statement such as @import before a rule.
      assert.ok(!preludes.some((outer) => !outer.startsWith("@")), `${prelude}: nested rule not read by the contrast check`);
      assert.ok(!prelude.includes(";"), `${prelude}: statement before a rule not read by the contrast check`);
      preludes.push(prelude);
      start = index + 1;
    } else if (css[index] === "}") {
      assert.ok(preludes.length > 0, "an unmatched } in the widget CSS is not read by the contrast check");
      const prelude = preludes.pop();
      if (!prelude.startsWith("@")) {
        const declarations = {};
        const important = new Set();
        for (const part of css.slice(start, index).split(";")) {
          if (!part.trim()) continue;
          const colon = part.indexOf(":");
          assert.ok(colon !== -1, `${prelude} { ${part.trim()} }: declaration not read by the contrast check`);
          const name = part.slice(0, colon).trim();
          assert.match(name, /^-{0,2}[a-z][a-z0-9-]*$/, `${prelude} { ${name} }: property name not read by the contrast check`);
          const property = name === "background-color" ? "background" : name;
          let value = part.slice(colon + 1).trim();
          if (/\s!important$/.test(value)) {
            important.add(property);
            value = value.slice(0, -"!important".length).trim();
          }
          assert.ok(value && !value.includes("!"), `${prelude} { ${name} }: value not read by the contrast check`);
          declarations[property] = value;
        }
        rules.push({ selector: prelude, declarations, important, condition: preludes.findLast((outer) => outer.startsWith("@")) ?? null });
      }
      start = index + 1;
    }
  }
  assert.ok(preludes.length === 0 && !css.slice(start).trim(), "a rule left open in the widget CSS is not read by the contrast check");
  return rules;
}

// The widget's custom properties (#170) put in for the var() that names one,
// so the checks below read the colors the browser computes. They are read only
// as the widget sets them: as hex values, once, on its top-level nodes outside
// at-rules, without !important, and named by a var() of nothing else. Any
// other use fails here instead of being read differently from the browser.
const TOKEN_ROOTS = ".pl-root, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection]";
function resolveTokens(rules) {
  const tokens = new Map();
  for (const { selector, declarations, important, condition } of rules) {
    for (const [name, value] of Object.entries(declarations).filter(([property]) => property.startsWith("--"))) {
      const where = `${selector} { ${name} }`;
      assert.ok(selector === TOKEN_ROOTS && !condition && !important.has(name), `${where}: custom property not read by the contrast check`);
      assert.match(value, /^#[\da-f]{3}(?:[\da-f]{3})?$/i, `${where}: custom property as a hex value`);
      assert.ok(!tokens.has(name), `${where}: custom property set twice`);
      tokens.set(name, value);
    }
  }
  return rules.map((rule) => {
    const declarations = { ...rule.declarations };
    for (const [property, value] of Object.entries(declarations)) {
      if (!value.includes("var(") || !["color", "background"].includes(property)) continue;
      const name = value.match(/^var\((--[a-z][a-z0-9-]*)\)$/)?.[1];
      assert.ok(name && tokens.has(name), `${rule.selector} { ${property}: ${value} }: not read by the contrast check`);
      declarations[property] = tokens.get(name);
    }
    return { ...rule, declarations };
  });
}

// A selector list split at its top-level commas (not those inside :is() and
// the like).
function selectorList(prelude) {
  const selectors = [];
  let depth = 0;
  let current = "";
  for (const char of prelude) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      selectors.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  selectors.push(current.trim());
  return selectors;
}

// What applies by selector outside at-rules: each selector of a list gets the
// rule, and a selector's rules are merged in source order, so a later rule's
// color or background wins as in the page.
function cascadedRules(rules) {
  const merged = new Map();
  for (const { selector: prelude, declarations, condition } of rules) {
    if (condition) continue;
    for (const selector of selectorList(prelude)) merged.set(selector, { ...merged.get(selector), ...declarations });
  }
  return merged;
}

test("every text color of the widget meets 4.5:1 on the backgrounds it is shown on (#125)", () => {
  const widget = widgetHarness();
  widget.init();
  const allRules = resolveTokens(styleRules(widget));
  // What sets the color of text or what is behind it. The checks below read
  // plain color, background and opacity outside at-rules; anything else that
  // could change the contrast fails here instead of passing unread.
  const contrastProperties = ["color", "background", "background-image", "opacity", "filter", "backdrop-filter", "mix-blend-mode", "-webkit-text-fill-color", "all"];
  const resets = [
    [".pl-root, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection]", "initial"],
    [".pl-root *, [data-patchloop-area] *", "revert"],
    [":is(.pl-root, .pl-root *, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-area] *, [data-patchloop-selection])::before, :is(.pl-root, .pl-root *, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-area] *, [data-patchloop-selection])::after", "revert"]
  ];
  const firstColored = allRules.findIndex(({ declarations }) => ["color", "background", "opacity"].some((property) => property in declarations));
  allRules.forEach(({ selector, declarations, important, condition }, index) => {
    for (const property of contrastProperties.filter((name) => name in declarations)) {
      const where = `${selector} { ${property} }`;
      assert.ok(!condition, `${where} in ${condition}: not checked for contrast`);
      assert.ok(!important.has(property), `${where} with !important: not checked for contrast`);
      if (property === "all") {
        // Only the reset at the top, which every color below overrides.
        assert.ok(resets.some(([reset, value]) => selector === reset && declarations.all === value) && index < firstColored, `${where}: resets colors the checks do not follow`);
      } else if (property === "opacity") {
        // Disabled buttons are left out (WCAG), exported cards are composited below.
        assert.ok([".pl-root button:disabled", ".pl-feedback-item-exported"].includes(selector), `${where}: not checked for contrast`);
      } else {
        assert.ok(["color", "background"].includes(property), `${where}: not computed by the contrast check`);
      }
    }
  });
  const rules = cascadedRules(allRules);
  const checked = new Set();
  const backgrounds = new Set();
  const check = (selector, backgroundSelector, composite = (color) => color) => {
    const background = rules.get(backgroundSelector)?.background;
    assert.ok(background, `${backgroundSelector} has a background`);
    const ratio = contrast(composite(rgb(rules.get(selector).color)), composite(rgb(background)));
    assert.ok(ratio >= 4.5, `${selector} on ${backgroundSelector}: ${ratio.toFixed(2)}`);
    checked.add(selector);
    backgrounds.add(backgroundSelector);
  };
  // A disabled control: WCAG leaves inactive components out of the contrast minimum.
  const exempt = new Set([".pl-actions [data-pl-download-all]:disabled"]);
  // Backgrounds no text is shown on.
  const withoutText = new Set([
    // The handle and the tuck button (#211) fill the collapsed panel with
    // backgrounds of their own.
    ".pl-panel.pl-collapsed", ".pl-feedback-active .pl-panel.pl-collapsed",
    // The tint of a selection or an area; the area's number is its button.
    ".pl-selection", ".pl-area", ".pl-area.pl-marker-done", ".pl-area.pl-marker-dot:not(:hover):not(:focus-within)",
    // A dot-only marker shows no number (font-size: 0), only the dot.
    ".pl-pin.pl-marker-dot", ".pl-area.pl-marker-dot button", ".pl-pin.pl-marker-dot::before", ".pl-area.pl-marker-dot button::before"
  ]);

  // Text on its own background: controls and boxes that only hold their own
  // text, or whose other text is checked on them below. Listed by name, so a
  // new box that sets both still fails until the text shown on it is checked.
  for (const selector of [
    ".pl-handle", ".pl-handle.pl-mode-on", ".pl-panel.pl-collapsed .pl-handle", ".pl-panel.pl-collapsed .pl-tuck", ".pl-tab", ".pl-mode",
    ".pl-actions button", ".pl-form-actions button", ".pl-actions [data-pl-download-all]", '.pl-form-actions button[type="submit"]',
    ".pl-delivery-settings input", ".pl-delivery-settings select", ".pl-feedback-actions button",
    ".pl-comment textarea", ".pl-comment input", ".pl-form-error", ".pl-tooltip", ".pl-pin", ".pl-area button",
    ".pl-capture-guide", ".pl-capture-guide button",
    ".pl-panel .pl-notice", '.pl-panel .pl-notice[data-state="error"]', ".pl-comment .pl-edit-note", ".pl-comment .pl-uncaptured-hint"
  ]) {
    check(selector, selector);
  }
  // The other states a control shows the same text color on.
  check(".pl-handle", ".pl-handle:hover");
  check(".pl-handle.pl-mode-on", ".pl-handle.pl-mode-on:hover");
  check(".pl-panel.pl-collapsed .pl-handle", ".pl-panel.pl-collapsed .pl-handle.pl-mode-on");
  check(".pl-panel.pl-collapsed .pl-tuck", ".pl-panel.pl-collapsed .pl-tuck.pl-mode-on");
  check(".pl-tab", ".pl-tab.pl-mode-on");
  check(".pl-mode", '.pl-mode[aria-pressed="true"]');
  check(".pl-pin", ".pl-pin.pl-marker-done");
  check(".pl-area button", ".pl-area.pl-marker-done button");
  check(".pl-feedback-num", ".pl-feedback-num.kind-point");
  check(".pl-feedback-num", ".pl-feedback-num.kind-area");
  check(".pl-list-heading", ".pl-list-heading span");
  // Text without a background of its own, on the box it is shown in.
  for (const selector of [".pl-delivery-settings summary", ".pl-delivery-settings label"]) {
    check(selector, ".pl-delivery-settings");
  }
  for (const selector of [".pl-root", ".pl-panel p", ".pl-feedback-list-empty", ".pl-list-heading", ".pl-display-mode legend", ".pl-display-mode label", ".pl-panel .pl-other-pages"]) {
    check(selector, ".pl-panel");
  }
  for (const selector of [".pl-root", ".pl-comment label", ".pl-form-heading span", ".pl-comment .pl-capture-note", ".pl-comment .pl-field-count", ".pl-keyboard-hint"]) {
    check(selector, ".pl-comment");
  }
  check(".pl-capture-guide small", ".pl-capture-guide");
  check(".pl-actions [data-pl-clear]", ".pl-actions button");
  check(".pl-feedback-actions [data-pl-delete]", ".pl-feedback-actions button");
  // Comment cards, plain and exported (an exported card may be faded).
  const alpha = Number(rules.get(".pl-feedback-item-exported").opacity ?? 1);
  const card = rgb(rules.get(".pl-feedback-item").background);
  const faded = (color) => color.map((value, index) => value * alpha + card[index] * (1 - alpha));
  for (const selector of [".pl-feedback-text", ".pl-feedback-meta", ".pl-feedback-status-ok", ".pl-feedback-status-unknown", ".pl-feedback-status-fail", ".pl-feedback-approx", ".pl-feedback-exported", ".pl-inbox-status", ".pl-inbox-status-done", ".pl-inbox-status-missing"]) {
    check(selector, ".pl-feedback-item");
    check(selector, ".pl-feedback-item-exported", faded);
  }

  // A text color or a background added later fails here until it is checked
  // above or listed as one no text is shown on.
  for (const [selector, rule] of rules) {
    if (rule.color) {
      assert.match(rule.color, /^#[\da-f]{3}(?:[\da-f]{3})?$/i, `${selector}: color as a hex value`);
      assert.ok(checked.has(selector) || exempt.has(selector), `${selector}: text color not checked for contrast`);
    }
    if (rule.background) {
      assert.ok(backgrounds.has(selector) || exempt.has(selector) || withoutText.has(selector), `${selector}: background not checked for contrast`);
    }
  }
});
