"use strict";

// Request-supplied values (feedback ids, comments) go into one-line log
// entries; escape newlines, control characters and quotes so a value cannot
// split the entry or forge another one (#150). JSON.stringify leaves DEL, the
// C1 controls (NEL among them) and the Unicode line/paragraph separators raw,
// and log viewers can break lines on them, so escape those too. A "%c" in a
// value still reaches console.*; calls that pass an Error after the message
// pin the format string to "%s" so the value cannot swallow the Error.
function logValue(value) {
  return JSON.stringify(String(value))
    .slice(1, -1)
    .replace(/[\x7f-\x9f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

module.exports = { logValue };
