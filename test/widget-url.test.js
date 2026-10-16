"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { applyPageUrlRule, applySourceContextUrlRule, normalizePageUrl, normalizeKeepQueryParams, pageUrlForSharing, samePersistedPage, sourceUrlForSharing } = require("../widget/src/url.js");

test("normalizePageUrl keeps origin and pathname, drops query and hash", () => {
  assert.equal(normalizePageUrl("https://demo.example/app?utm=x#sec"), "https://demo.example/app");
  assert.equal(normalizePageUrl("https://demo.example/app/"), "https://demo.example/app/");
});

test("normalizePageUrl resolves a relative url against the base", () => {
  assert.equal(normalizePageUrl("/app?q=1", "https://demo.example/other#h"), "https://demo.example/app");
});

test("normalizePageUrl returns empty string for unparseable input", () => {
  assert.equal(normalizePageUrl("not a url"), "");
  assert.equal(normalizePageUrl(undefined), "");
});

test("samePersistedPage ignores query and hash on the same page", () => {
  assert.equal(samePersistedPage("https://demo.example/app", "https://demo.example/app#section"), true);
  assert.equal(samePersistedPage("https://demo.example/app?a=1", "https://demo.example/app?b=2"), true);
  // A full href stored by an older build still matches after a hash is added.
  assert.equal(samePersistedPage("https://demo.example/app?old=1#top", "https://demo.example/app"), true);
});

test("samePersistedPage distinguishes different paths and origins", () => {
  assert.equal(samePersistedPage("https://demo.example/app", "https://demo.example/other"), false);
  assert.equal(samePersistedPage("https://demo.example/app", "https://evil.example/app"), false);
});

test("samePersistedPage is false when the current url is unparseable", () => {
  assert.equal(samePersistedPage("https://demo.example/app", "not a url"), false);
});

test("samePersistedPage rejects a missing, empty, or relative stored url", () => {
  // The stored pageUrl must be a full href; an empty/relative value must not be
  // resolved against the current page and falsely match it.
  assert.equal(samePersistedPage("", "https://demo.example/app"), false);
  assert.equal(samePersistedPage(undefined, "https://demo.example/app"), false);
  assert.equal(samePersistedPage("/app", "https://demo.example/app"), false);
});

test("pageUrlForSharing keeps only origin and path by default", () => {
  assert.equal(pageUrlForSharing("https://demo.example/app?token=abc&utm=x#access_token=zzz", []), "https://demo.example/app");
  assert.equal(pageUrlForSharing("https://demo.example", []), "https://demo.example/");
  assert.equal(pageUrlForSharing("https://demo.example/app?#", []), "https://demo.example/app");
});

test("pageUrlForSharing keeps the listed query keys in order with their raw values", () => {
  const url = "https://demo.example:8080/flow?step=2&token=abc&evidence=a%20b+c&step=3&evidence#state=x";
  assert.equal(pageUrlForSharing(url, ["step", "evidence"]), "https://demo.example:8080/flow?step=2&evidence=a%20b+c&step=3&evidence");
  // Keys match after decoding, exactly and case-sensitively.
  assert.equal(pageUrlForSharing("https://demo.example/a?st%65p=1&Step=2&s+t=3", ["step", "s t"]), "https://demo.example/a?st%65p=1&s+t=3");
  // A leading "?" is part of the key the page sees, so `?step` is not `step`.
  assert.equal(pageUrlForSharing("https://demo.example/a?step=2&?step=SECRET", ["step"]), "https://demo.example/a?step=2");
  assert.equal(pageUrlForSharing("https://demo.example/a?step=2&?step=x", ["?step"]), "https://demo.example/a??step=x");
});

test("pageUrlForSharing drops credentials and the fragment on any scheme", () => {
  assert.equal(pageUrlForSharing("https://user:secret@demo.example/app?step=1#h", ["step"]), "https://demo.example/app?step=1");
  assert.equal(pageUrlForSharing("file:///work/demo.html?step=1&t=2#h", ["step"]), "file:///work/demo.html?step=1");
});

test("pageUrlForSharing returns empty string for unparseable or relative input", () => {
  assert.equal(pageUrlForSharing("not a url", ["step"]), "");
  assert.equal(pageUrlForSharing("/app?step=1", ["step"]), "");
  assert.equal(pageUrlForSharing(undefined, []), "");
});

test("normalizeKeepQueryParams accepts an array of keys and treats an omitted value as none", (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  assert.deepEqual(normalizeKeepQueryParams(["step", "evidence"]), ["step", "evidence"]);
  assert.deepEqual(normalizeKeepQueryParams(undefined), []);
  assert.equal(warnings.mock.callCount(), 0);
});

test("normalizeKeepQueryParams warns and keeps less on a malformed value", (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  assert.deepEqual(normalizeKeepQueryParams("step"), []);
  assert.deepEqual(normalizeKeepQueryParams(null), []);
  assert.deepEqual(normalizeKeepQueryParams(["step", "", 3, null]), ["step"]);
  assert.equal(warnings.mock.callCount(), 3);
});

test("applyPageUrlRule trims a comment's page.url in place and reports a change", () => {
  const item = { id: "pl_1", page: { url: "https://demo.example/flow?step=2&token=abc#h", title: "Flow" } };
  assert.equal(applyPageUrlRule(item, ["step"]), true);
  assert.deepEqual(item.page, { url: "https://demo.example/flow?step=2", title: "Flow" });
  assert.equal(applyPageUrlRule(item, ["step"]), false);
});

test("applyPageUrlRule leaves comments without a string page.url alone", () => {
  assert.equal(applyPageUrlRule(null, []), false);
  assert.equal(applyPageUrlRule({ id: "pl_2" }, []), false);
  const item = { id: "pl_3", page: { url: null } };
  assert.equal(applyPageUrlRule(item, []), false);
  assert.equal(item.page.url, null);
});

// --- sourceContext URLs (#122) ---------------------------------------------

test("sourceUrlForSharing applies page.url's rule to an absolute URL", () => {
  const url = "https://user:pass@preview.example/app?token=abc&step=2#frag";
  assert.equal(sourceUrlForSharing(url, []), "https://preview.example/app");
  assert.equal(sourceUrlForSharing(url, ["step"]), "https://preview.example/app?step=2");
});

test("sourceUrlForSharing keeps a relative URL's path and listed query keys and drops its fragment", () => {
  assert.equal(sourceUrlForSharing("/builds/42?token=abc&step=2#log", ["step"]), "/builds/42?step=2");
  assert.equal(sourceUrlForSharing("builds/42?token=abc", []), "builds/42");
  assert.equal(sourceUrlForSharing("builds/42#log", []), "builds/42");
  assert.equal(sourceUrlForSharing("builds/42", []), "builds/42");
});

test("sourceUrlForSharing takes a protocol-relative URL as https, so credentials go too", () => {
  assert.equal(sourceUrlForSharing("//user:pass@preview.example/app?token=abc", []), "//preview.example/app");
  assert.equal(sourceUrlForSharing("\\\\user:pass@preview.example/app?token=abc", []), "//preview.example/app");
  assert.equal(sourceUrlForSharing("ht\ttps://user:pass@preview.example/app?token=abc", []), "https://preview.example/app");
});

test("sourceUrlForSharing empties an absolute or protocol-relative URL that does not parse", () => {
  for (const url of [
    "https://user:pass@preview.example:bad/app?token=x#frag", "//user:pass@preview.example:bad/app", "http://[::1/app",
    // As the URL parser reads them: tabs and newlines inside, controls and spaces at the ends.
    "ht\ttps://user:pass@preview.example:bad/app?token=x", "\n https://user:pass@preview.example:bad/", " //user:pass@host:bad/", "\\\\user:pass@host:bad/"
  ]) {
    assert.equal(sourceUrlForSharing(url, ["token"]), "", url);
  }
  // A relative path that only looks odd stays a path.
  assert.equal(sourceUrlForSharing("builds/a:b?step=1", ["step"]), "builds/a:b?step=1");
});

test("sourceUrlForSharing leaves what is not a URL string as it is", () => {
  for (const value of [undefined, null, "", 42]) assert.equal(sourceUrlForSharing(value, []), value);
});

test("applyPageUrlRule also narrows the sourceContext URLs, and only those", () => {
  const item = {
    page: { url: "https://demo.example/flow?token=abc" },
    sourceContext: { repo: "acme/shop", branch: "main", previewUrl: "https://preview.example/app?token=abc#x", buildUrl: "https://ci.example/b/1?step=2" }
  };
  assert.equal(applyPageUrlRule(item, ["step"]), true);
  assert.deepEqual(item, {
    page: { url: "https://demo.example/flow" },
    sourceContext: { repo: "acme/shop", branch: "main", previewUrl: "https://preview.example/app", buildUrl: "https://ci.example/b/1?step=2" }
  });
  assert.equal(applyPageUrlRule(item, ["step"]), false);
  assert.equal(applySourceContextUrlRule(null, []), false);
  assert.equal(applyPageUrlRule({ sourceContext: { previewUrl: "https://preview.example/app" } }, []), false);
});

