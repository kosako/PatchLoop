"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizePageUrl, samePersistedPage } = require("../widget/src/url.js");

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
