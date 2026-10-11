// Page-identity helpers for persisted feedback.
//
// Saved feedback is keyed by the page it was left on. Using the full
// `location.href` (which includes the query string and hash) is too strict:
// after anchor navigation (`#section`), tracking params (`?utm=...`), or a
// normalizing redirect, the URL no longer matches byte-for-byte and the saved
// feedback is silently dropped — and then overwritten. The envelope is already
// scoped by projectId/demoId, so comparing only origin + pathname is enough.

export function normalizePageUrl(url, base) {
  try {
    const parsed = new URL(url, base);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return "";
  }
}

// The page URL that leaves the browser (#163). `location.href` can carry a
// share token, a magic link, or an OAuth fragment, and the payload is
// forwarded to the inbox, Slack, GitHub, and exported files. Keep the page
// itself (origin + path) plus only the query keys the embedding side listed;
// the fragment and any credentials are always dropped. An unparseable or
// relative url returns "", as nothing in it can be told safe to keep.
export function pageUrlForSharing(url, keepQueryParams) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return "";
  }
  const keep = new Set(keepQueryParams);
  // Filter the raw `key=value` pairs instead of re-serializing them, so a kept
  // value reaches the inbox exactly as the page had it.
  const kept = parsed.search.slice(1).split("&")
    .filter((pair) => pair !== "" && keep.has(new URLSearchParams(pair).keys().next().value));
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = kept.join("&");
  return parsed.href;
}

// The `keepQueryParams` init option: an array of query keys, matched exactly.
// Anything else is a configuration mistake, so warn and keep less (never more)
// than asked.
export function normalizeKeepQueryParams(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    console.warn("[PatchLoop] keepQueryParams must be an array of query keys; keeping no query", value);
    return [];
  }
  const keys = value.filter((key) => typeof key === "string" && key !== "");
  if (keys.length !== value.length) {
    console.warn("[PatchLoop] keepQueryParams ignored entries that are not non-empty strings", value);
  }
  return keys;
}

export function samePersistedPage(storedUrl, currentUrl) {
  if (typeof storedUrl !== "string" || storedUrl === "") return false;
  // The stored pageUrl is always an absolute URL (the save side writes the
  // current page's URL). Parse both WITHOUT a base so a missing, empty,
  // relative, or otherwise malformed stored value cannot be resolved against
  // the current page and falsely match it.
  const stored = normalizePageUrl(storedUrl, undefined);
  const current = normalizePageUrl(currentUrl, undefined);
  return stored !== "" && stored === current;
}
