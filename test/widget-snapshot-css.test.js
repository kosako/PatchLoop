"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { freezeViewportUnits, flattenRulesForSnapshot } = require("../widget/src/snapshot-css.js");

test("freezeViewportUnits resolves viewport units against the captured size", () => {
  const frozen = (css) => freezeViewportUnits(css, 1000, 500);
  assert.equal(frozen("width: 100vw;"), "width: 1000px;");
  assert.equal(frozen("height: 50vh;"), "height: 250px;");
  assert.equal(frozen("font-size: 10vmin;"), "font-size: 50px;");
  assert.equal(frozen("font-size: 10vmax;"), "font-size: 100px;");
  assert.equal(frozen("width: .5vw;"), "width: 5px;");
  assert.equal(frozen("margin: -50vw;"), "margin: -500px;");
  assert.equal(frozen("margin:-50vw;"), "margin:-500px;");
  assert.equal(frozen("width: 12.5vw;"), "width: 125px;");
  assert.equal(frozen("width: 100dvw; height: 100svh;"), "width: 1000px; height: 500px;");
  assert.equal(frozen("width: calc(100vw - 50px);"), "width: calc(1000px - 50px);");
});

test("freezeViewportUnits leaves lookalikes outside declaration values alone", () => {
  const frozen = (css) => freezeViewportUnits(css, 1000, 500);
  // base64 in a data URI
  const dataUri = 'background: url("data:image/png;base64,iVBORw0A9vw/9vwX+5vh=");';
  assert.equal(frozen(dataUri), dataUri);
  // escaped utility-class selector
  const escaped = ".h-\\[100vh\\] { color: red; }";
  assert.equal(frozen(escaped), escaped);
  // custom property *name* keeps its name (the value is still resolved)
  assert.equal(frozen("--col-50vw: 10px;"), "--col-50vw: 10px;");
  assert.equal(frozen("--width: 50vw;"), "--width: 500px;");
});

function styleRule(cssText) {
  return { cssText };
}

function mediaRule(mediaText, children) {
  return { media: { mediaText }, cssRules: children };
}

function groupRule(header, children) {
  return { cssRules: children, cssText: `${header} {\n  ...\n}` };
}

const matchesNarrow = (mediaText) => mediaText.includes("max-width");

test("flattenRulesForSnapshot inlines matching media and drops the rest", () => {
  const rules = [
    styleRule("body { color: red; }"),
    mediaRule("(max-width: 600px)", [styleRule(".narrow { display: none; }")]),
    mediaRule("(min-width: 1200px)", [styleRule(".wide { display: none; }")])
  ];
  assert.equal(
    flattenRulesForSnapshot(rules, matchesNarrow),
    "body { color: red; }\n.narrow { display: none; }"
  );
});

test("flattenRulesForSnapshot keeps grouping wrappers but resolves nested media", () => {
  const supports = groupRule("@supports (display: grid)", [
    styleRule(".grid { display: grid; }"),
    mediaRule("(max-width: 600px)", [styleRule(".grid { gap: 4px; }")]),
    mediaRule("(min-width: 1200px)", [styleRule(".grid { gap: 24px; }")])
  ]);
  assert.equal(
    flattenRulesForSnapshot([supports], matchesNarrow),
    "@supports (display: grid) {\n.grid { display: grid; }\n.grid { gap: 4px; }\n}"
  );

  const layer = groupRule("@layer components", [mediaRule("(min-width: 1200px)", [styleRule(".x{}")])]);
  assert.equal(flattenRulesForSnapshot([layer], matchesNarrow), "");
});

test("flattenRulesForSnapshot preserves @keyframes wholesale", () => {
  const keyframes = groupRule("@keyframes spin", [
    styleRule("0% { transform: rotate(0deg); }"),
    styleRule("100% { transform: rotate(360deg); }")
  ]);
  assert.equal(
    flattenRulesForSnapshot([keyframes], matchesNarrow),
    "@keyframes spin {\n0% { transform: rotate(0deg); }\n100% { transform: rotate(360deg); }\n}"
  );
});

test("flattenRulesForSnapshot inlines @import sheets, honoring their media list", () => {
  const importedMatch = {
    media: { mediaText: "(max-width: 600px)" },
    styleSheet: { cssRules: [styleRule(".imported { color: blue; }")] }
  };
  const importedSkip = {
    media: { mediaText: "(min-width: 1200px)" },
    styleSheet: { cssRules: [styleRule(".skipped {}")] }
  };
  const importedUnreadable = {
    styleSheet: {
      get cssRules() {
        throw new Error("cross-origin");
      }
    }
  };
  assert.equal(
    flattenRulesForSnapshot([importedMatch, importedSkip, importedUnreadable], matchesNarrow),
    ".imported { color: blue; }"
  );
});
