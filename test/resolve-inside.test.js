"use strict";

// The one check for a path inside a directory (#170).

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolveInside } = require("../server/resolve-inside.js");

const root = path.resolve("pl-resolve-inside-root");

test("a name inside the directory resolves to its path", () => {
  assert.equal(resolveInside(root, "a.svg"), path.join(root, "a.svg"));
  assert.equal(resolveInside(root, "..a.svg"), path.join(root, "..a.svg"));
  assert.equal(resolveInside(root, `sub${path.sep}..${path.sep}a.svg`), path.join(root, "a.svg"));
  assert.equal(resolveInside(`${root}${path.sep}`, "a.svg"), path.join(root, "a.svg"));
  assert.equal(resolveInside(root, path.join(root, "a.svg")), path.join(root, "a.svg"));
});

test("the directory itself, a path outside it and a NUL resolve to nothing", () => {
  for (const name of ["", ".", "..", `..${path.sep}a.svg`, `a${path.sep}..${path.sep}..${path.sep}a.svg`, path.dirname(root), path.join(path.dirname(root), "a.svg"), `${root}-sibling${path.sep}a.svg`, "a\0b.svg"]) {
    assert.equal(resolveInside(root, name), null, JSON.stringify(name));
  }
});

test("a filesystem root as the directory contains nothing", () => {
  const filesystemRoot = path.parse(root).root;
  assert.equal(resolveInside(filesystemRoot, "a.svg"), null);
  assert.equal(resolveInside(filesystemRoot, path.join(filesystemRoot, "a.svg")), null);
});
