"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSourceContext } = require("../widget/src/source-context.js");

// Minimal document stand-in: resolveSourceContext only touches
// querySelector(`meta[name="..."]`) and the matched node's content.
function docWithMeta(metaByName = {}) {
  return {
    querySelector(selector) {
      const match = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (!match || !(match[1] in metaByName)) return null;
      return { content: metaByName[match[1]] };
    }
  };
}

test("resolveSourceContext takes known fields from the init option", () => {
  const context = resolveSourceContext({
    repo: "acme/shop",
    branch: "feature/checkout",
    commit: "abc1234",
    root: "apps/web",
    buildUrl: "https://ci.example/build/1",
    previewUrl: "https://preview.example/pr-1"
  }, docWithMeta());

  assert.deepEqual(context, {
    repo: "acme/shop",
    branch: "feature/checkout",
    commit: "abc1234",
    root: "apps/web",
    buildUrl: "https://ci.example/build/1",
    previewUrl: "https://preview.example/pr-1"
  });
});

test("resolveSourceContext drops unknown keys and non-string values", () => {
  const context = resolveSourceContext({
    repo: "acme/shop",
    commit: 1234,
    extra: "nope",
    branch: { name: "feature/checkout" }
  }, docWithMeta());

  assert.deepEqual(context, { repo: "acme/shop" });
});

test("resolveSourceContext fills missing fields from meta tags per field", () => {
  const doc = docWithMeta({
    "patchloop:repo": "meta/repo",
    "patchloop:commit": "def5678",
    "patchloop:build-url": "https://ci.example/build/2"
  });

  const context = resolveSourceContext({ repo: "acme/shop", branch: "main" }, doc);

  // The option wins where present; meta only fills the gaps.
  assert.deepEqual(context, {
    repo: "acme/shop",
    branch: "main",
    commit: "def5678",
    buildUrl: "https://ci.example/build/2"
  });
});

test("resolveSourceContext treats blank strings as absent", () => {
  const doc = docWithMeta({ "patchloop:commit": "def5678" });

  // An unfilled template placeholder ("" or whitespace) must fall through to
  // the meta tag instead of shipping an empty field.
  const context = resolveSourceContext({ commit: "  ", repo: "" }, doc);

  assert.deepEqual(context, { commit: "def5678" });
});

test("resolveSourceContext returns null when nothing is configured", () => {
  assert.equal(resolveSourceContext(null, docWithMeta()), null);
  assert.equal(resolveSourceContext(undefined, docWithMeta()), null);
  assert.equal(resolveSourceContext("acme/shop", docWithMeta()), null);
  assert.equal(resolveSourceContext({ repo: "" }, docWithMeta({ "patchloop:repo": "  " })), null);
});
