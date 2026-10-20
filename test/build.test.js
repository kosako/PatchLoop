"use strict";

// The build script, run from the command line and required by the widget tests
// (#170). Each test builds a copy of the script in a temp directory, with a
// small widget/src of its own, so the repo's dist is never written.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function fixture(t, sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pl-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(__dirname, "../scripts/build.js"), path.join(root, "scripts/build.js"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  fs.mkdirSync(path.join(root, "widget/src"), { recursive: true });
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, "widget/src", name), source);
  const script = path.join(root, "scripts/build.js");
  const dist = path.join(root, "dist/patchloop-widget.js");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  return { root, script, dist, run };
}

// The exit code and each stream, so a message on the wrong stream fails too.
const outcome = ({ status, stdout, stderr }) => `${status} stdout:${stdout} stderr:${stderr}`;

const SOURCES = {
  "index.js": 'import { greeting } from "./greeting.js";\nwindow.out = greeting;\n',
  "greeting.js": 'export const greeting = "hello";\n'
};
const STALE = "1 stdout: stderr:[build] dist/patchloop-widget.js is stale. Run `npm run build` and commit the result.\n";

test("from the command line, the build script writes the bundle and checks it as before (#170)", (t) => {
  const { script, dist, run } = fixture(t, SOURCES);
  const output = require(script).build();

  assert.equal(outcome(run("--check")), STALE);
  assert.equal(outcome(run()), `0 stdout:[build] wrote ${path.join("dist", "patchloop-widget.js")} (${output.length} bytes)\n stderr:`);
  assert.equal(fs.readFileSync(dist, "utf8"), output);
  assert.equal(outcome(run("--check")), "0 stdout:[build] dist/patchloop-widget.js is up to date\n stderr:");

  fs.appendFileSync(dist, "// edited\n");
  assert.equal(outcome(run("--check")), STALE);
});

test("required, the build script returns the bundle without writing it, and throws what it cannot read (#170)", (t) => {
  const { root, script, dist, run } = fixture(t, SOURCES);
  const { build } = require(script);
  const output = build();

  assert.equal(fs.existsSync(path.join(root, "dist")), false);
  assert.equal(output.startsWith("/*! PatchLoop Widget v0.0.0-test"), true);
  assert.equal(output.includes('const { greeting } = __pl_widget_src_greeting;\nwindow.out = greeting;'), true);

  const unreadable = "widget/src/index.js:1: only single-line named imports from relative paths are supported";
  fs.writeFileSync(path.join(root, "widget/src/index.js"), 'import * as greeting from "./greeting.js";\n');
  assert.throws(() => build(), { name: "BuildError", message: unreadable });
  assert.equal(outcome(run()), `1 stdout: stderr:[build] ${unreadable}\n`);
  assert.equal(fs.existsSync(dist), false);
});

test("an error that is not the bundler's own is thrown as it is, not printed as a build error (#170)", (t) => {
  const { root, script, dist, run } = fixture(t, {});
  fs.mkdirSync(path.join(root, "widget/src/index.js"));

  assert.throws(() => require(script).build(), { code: "EISDIR" });
  const { status, stdout, stderr } = run();
  assert.equal(`${status} stdout:${stdout}`, "1 stdout:");
  assert.equal(stderr.startsWith("[build]"), false);
  assert.equal(stderr.includes("EISDIR"), true);
  assert.equal(fs.existsSync(dist), false);
});
