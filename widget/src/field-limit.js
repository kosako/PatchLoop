import { DEFAULTS, state } from "./state.js";

// The `maxFieldLength` init option (#196): a positive integer, counted as the
// receiver counts (string.length). Anything else is a configuration mistake,
// so warn and keep the receiver's default.
export function normalizeMaxFieldLength(value) {
  if (value === undefined) return DEFAULTS.maxFieldLength;
  if (Number.isSafeInteger(value) && value > 0) return value;
  console.warn(`[PatchLoop] maxFieldLength must be a positive integer; using ${DEFAULTS.maxFieldLength}`, value);
  return DEFAULTS.maxFieldLength;
}

// Whether the receiver would refuse the comment for its text or its name: it
// refuses the post (413), and an import refuses the whole file for one.
export function exceedsFieldLimit(item, limit = state.options.maxFieldLength) {
  return String(item?.comment ?? "").length > limit || String(item?.reviewer ?? "").length > limit;
}
