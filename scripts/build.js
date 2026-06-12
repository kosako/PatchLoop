"use strict";

// Zero-dependency bundler for the widget: resolves the relative ESM imports
// under widget/src and emits a single IIFE at dist/patchloop-widget.js.
// Supported syntax is intentionally narrow (single-line named imports and
// named exports); anything else fails the build with an explicit error so
// the source never drifts away from what this script understands.
//
//   node scripts/build.js          build dist/patchloop-widget.js
//   node scripts/build.js --check  fail if dist is stale (used by npm run check)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENTRY_PATH = path.join(ROOT, "widget", "src", "index.js");
const DIST_PATH = path.join(ROOT, "dist", "patchloop-widget.js");

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*["'](\.\.?\/[^"']+)["'];?\s*$/;
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_VAR_RE = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?\s*$/;

function fail(message) {
  console.error(`[build] ${message}`);
  process.exit(1);
}

function moduleVarName(relativePath) {
  return `__pl_${relativePath.replace(/\.js$/, "").replace(/[^A-Za-z0-9]+/g, "_")}`;
}

function parseBindingList(raw, context) {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (!match) fail(`${context}: unsupported binding "${part}"`);
      return { source: match[1], local: match[2] || match[1] };
    });
}

// Parses one module into { imports, exports, bodyLines }. Import statements
// are removed from the body; `export` keywords are stripped in place.
function parseModule(filePath) {
  const relative = path.relative(ROOT, filePath).replaceAll(path.sep, "/");
  if (!fs.existsSync(filePath)) fail(`${relative}: file not found`);
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const imports = [];
  const exports = [];
  const bodyLines = [];

  lines.forEach((line, index) => {
    const where = `${relative}:${index + 1}`;

    if (/^\s*import\b/.test(line)) {
      const match = IMPORT_RE.exec(line.trim());
      if (!match) {
        fail(`${where}: only single-line named imports from relative paths are supported`);
      }
      imports.push({
        bindings: parseBindingList(match[1], where),
        targetPath: path.resolve(path.dirname(filePath), match[2])
      });
      return;
    }

    if (/^export\b/.test(line)) {
      const listMatch = EXPORT_LIST_RE.exec(line.trim());
      if (listMatch) {
        parseBindingList(listMatch[1], where).forEach(({ source, local }) => {
          exports.push({ exported: local, local: source });
        });
        return;
      }
      const declMatch = EXPORT_DECL_RE.exec(line) || EXPORT_VAR_RE.exec(line);
      if (!declMatch) {
        fail(`${where}: only named export declarations and export lists are supported`);
      }
      exports.push({ exported: declMatch[1], local: declMatch[1] });
      bodyLines.push(line.replace(/^export\s+/, ""));
      return;
    }

    bodyLines.push(line);
  });

  return { path: filePath, relative, imports, exports, bodyLines };
}

// Depth-first post-order from the entry, so every module is emitted before
// its importers. Cycles cannot be expressed in the output and are an error.
function collectModules(entryPath) {
  const ordered = [];
  const states = new Map();

  function visit(filePath, importChain) {
    const state = states.get(filePath);
    if (state === "done") return;
    if (state === "visiting") {
      fail(`circular import: ${[...importChain, filePath].map((p) => path.relative(ROOT, p)).join(" -> ")}`);
    }
    states.set(filePath, "visiting");
    const mod = parseModule(filePath);
    mod.imports.forEach((imp) => visit(imp.targetPath, [...importChain, filePath]));
    states.set(filePath, "done");
    ordered.push(mod);
  }

  visit(entryPath, []);
  return ordered;
}

function renderImports(mod) {
  return mod.imports.map((imp) => {
    const bindings = imp.bindings
      .map(({ source, local }) => (source === local ? source : `${source}: ${local}`))
      .join(", ");
    return `const { ${bindings} } = ${moduleVarName(path.relative(ROOT, imp.targetPath))};`;
  });
}

function renderModule(mod, isEntry) {
  const body = [...renderImports(mod), ...mod.bodyLines];
  if (isEntry) return body.join("\n");

  const exported = mod.exports
    .map(({ exported, local }) => (exported === local ? exported : `${exported}: ${local}`))
    .join(", ");
  return [
    `// --- ${mod.relative} ---`,
    `const ${moduleVarName(mod.relative)} = (() => {`,
    ...body,
    `return { ${exported} };`,
    `})();`
  ].join("\n");
}

function build() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const modules = collectModules(ENTRY_PATH);
  const entry = modules[modules.length - 1];
  const parts = modules.map((mod) => renderModule(mod, mod === entry));
  return [
    `/*! PatchLoop Widget v${pkg.version} — generated by scripts/build.js; do not edit. */`,
    "(() => {",
    `"use strict";`,
    ...parts,
    "})();",
    ""
  ].join("\n");
}

function main() {
  const output = build();

  if (process.argv.includes("--check")) {
    const current = fs.existsSync(DIST_PATH) ? fs.readFileSync(DIST_PATH, "utf8") : null;
    if (current !== output) {
      fail("dist/patchloop-widget.js is stale. Run `npm run build` and commit the result.");
    }
    console.log("[build] dist/patchloop-widget.js is up to date");
    return;
  }

  fs.mkdirSync(path.dirname(DIST_PATH), { recursive: true });
  fs.writeFileSync(DIST_PATH, output);
  console.log(`[build] wrote ${path.relative(ROOT, DIST_PATH)} (${output.length} bytes)`);
}

main();
