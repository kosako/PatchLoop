"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSourceContext } = require("../widget/src/source-context.js");
const { SOURCE_CONTEXT_FIELDS, SOURCE_CONTEXT_KEYS } = require("../shared/contract.js");

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

test("the sourceContext fields and their meta tags are the ones the README lists (#170)", () => {
  assert.equal(SOURCE_CONTEXT_FIELDS.map(({ key, metaName }) => `${key}=${metaName}`).join(","),
    "repo=patchloop:repo,branch=patchloop:branch,commit=patchloop:commit,root=patchloop:root,buildUrl=patchloop:build-url,previewUrl=patchloop:preview-url");
});

test("resolveSourceContext reads each field the receiver checks from its meta tag (#170)", () => {
  const doc = docWithMeta(Object.fromEntries(SOURCE_CONTEXT_FIELDS.map(({ key, metaName }) => [metaName, `meta-${key}`])));
  const context = resolveSourceContext(null, doc);
  assert.equal(SOURCE_CONTEXT_KEYS.map((key) => context[key]).join(","), SOURCE_CONTEXT_KEYS.map((key) => `meta-${key}`).join(","));
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
