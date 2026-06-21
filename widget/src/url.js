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

export function samePersistedPage(storedUrl, currentUrl) {
  const stored = normalizePageUrl(storedUrl, currentUrl);
  const current = normalizePageUrl(currentUrl, currentUrl);
  return stored !== "" && stored === current;
}
