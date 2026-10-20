"use strict";

const path = require("path");

// The path of `name` inside the directory `root`, or null when it resolves to
// root itself or outside it, or holds a NUL (fs throws on it rather than
// failing the call). Serving /static/ and /screenshots/ and deleting a stored
// screenshot all check with this one function (#170); saveScreenshot builds
// its file name from safe characters only.
// - The check is the one the three places had: the resolved path starts with
//   root and a separator, compared as strings, case and all. path.relative
//   would compare Windows paths ignoring case, which lets a stored path into
//   a directory whose name differs only in case.
// - A filesystem root (/ or C:\) as root contains nothing: the check above
//   never matched under it (root and a separator double the separator), and
//   serving or deleting across a whole drive is not what a screenshot or
//   static directory is for.
// paths is the path module to resolve with; tests pass path.win32 or
// path.posix to check one platform's rules on any other.
function insideChecker(paths) {
  return function resolveInside(root, name) {
    if (name.includes("\0")) return null;
    const base = paths.resolve(root);
    if (paths.parse(base).root === base) return null;
    const resolved = paths.resolve(base, name);
    return resolved.startsWith(`${base}${paths.sep}`) ? resolved : null;
  };
}

module.exports = { resolveInside: insideChecker(path), insideChecker };
