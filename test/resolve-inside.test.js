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

// The same rules on each platform, checked from any one (#170).
const { insideChecker } = require("../server/resolve-inside.js");

test("on Windows, a path whose directory differs only in case, another drive or the drive root is outside", () => {
  const resolveWin = insideChecker(path.win32);
  assert.equal(resolveWin("C:\\data\\Shots", "C:\\data\\Shots\\a.svg"), "C:\\data\\Shots\\a.svg");
  assert.equal(resolveWin("C:\\data\\Shots\\", "a.svg"), "C:\\data\\Shots\\a.svg");
  for (const name of ["C:\\data\\shots\\a.svg", "C:\\DATA\\Shots\\a.svg", "D:\\data\\Shots\\a.svg", "..\\a.svg", "C:\\data\\Shots", "C:\\data\\Shots-sibling\\a.svg"]) {
    assert.equal(resolveWin("C:\\data\\Shots", name), null, name);
  }
  assert.equal(resolveWin("C:\\", "a.svg"), null);
});

test("on POSIX, a path whose directory differs only in case is outside", () => {
  const resolvePosix = insideChecker(path.posix);
  assert.equal(resolvePosix("/data/Shots", "/data/Shots/a.svg"), "/data/Shots/a.svg");
  assert.equal(resolvePosix("/data/Shots", "/data/shots/a.svg"), null);
  assert.equal(resolvePosix("/", "a.svg"), null);
});
