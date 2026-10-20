"use strict";

const path = require("path");

// The path of `name` inside the directory `root`, or null when it resolves to
// root itself or outside it, or holds a NUL (fs throws on it rather than
// failing the call). Serving /static/ and /screenshots/ and deleting a stored
// screenshot all check with this one function (#170); saveScreenshot builds
// its file name from safe characters only. A filesystem root (/ or C:\) as
// root contains nothing: the checks this replaced never matched under it, and
// serving or deleting across a whole drive is not what a screenshot or
// static directory is for.
function resolveInside(root, name) {
  if (name.includes("\0")) return null;
  const base = path.resolve(root);
  if (path.parse(base).root === base) return null;
  const resolved = path.resolve(base, name);
  const relative = path.relative(base, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

module.exports = { resolveInside };
