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
  const kept = keptQueryPairs(parsed.search.slice(1), keepQueryParams);
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  // The setter drops one leading "?" too; give it one so a kept `?step=x`
  // keeps its key.
  parsed.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  return parsed.href;
}

// Filter the raw `key=value` pairs instead of re-serializing them, so a kept
// value reaches the inbox exactly as the page had it. The URL parser drops one
// leading "?", so prefix one: a pair like `?step=x` decodes to the key `?step`
// the page itself sees, not to `step`.
function keptQueryPairs(query, keepQueryParams) {
  const keep = new Set(keepQueryParams);
  return query.split("&")
    .filter((pair) => pair !== "" && keep.has(new URLSearchParams(`?${pair}`).keys().next().value));
}

// The sourceContext URLs (previewUrl, buildUrl) the embedding side passes
// (#122): a preview's share link can carry a token as well, so they leave
// under page.url's rule. They may be relative, as the page's URL never is:
// one keeps its path and only the listed query keys, and loses its fragment;
// a protocol-relative one is taken as https, which drops any credentials. One
// with a scheme or "//" that does not parse returns "", as nothing in it can
// be told safe to keep (it could hold credentials).
const SCHEME_OR_AUTHORITY = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

export function sourceUrlForSharing(url, keepQueryParams) {
  if (typeof url !== "string" || url === "") return url;
  const protocolRelative = url.startsWith("//");
  const absolute = pageUrlForSharing(protocolRelative ? `https:${url}` : url, keepQueryParams);
  if (absolute) return protocolRelative ? absolute.slice("https:".length) : absolute;
  if (SCHEME_OR_AUTHORITY.test(url)) return "";
  const withoutFragment = url.split("#")[0];
  const question = withoutFragment.indexOf("?");
  if (question === -1) return withoutFragment;
  const kept = keptQueryPairs(withoutFragment.slice(question + 1), keepQueryParams);
  return `${withoutFragment.slice(0, question)}${kept.length > 0 ? `?${kept.join("&")}` : ""}`;
}

const SOURCE_CONTEXT_URL_KEYS = ["previewUrl", "buildUrl"];

// Applies the rule to a sourceContext's URLs in place; whether any changed.
export function applySourceContextUrlRule(context, keepQueryParams) {
  if (!context || typeof context !== "object") return false;
  let changed = false;
  SOURCE_CONTEXT_URL_KEYS.forEach((key) => {
    const url = sourceUrlForSharing(context[key], keepQueryParams);
    if (url === context[key]) return;
    context[key] = url;
    changed = true;
  });
  return changed;
}

// Applies keepQueryParams to a comment's page.url and sourceContext URLs in
// place and tells whether anything changed (#163, #122). Used when saved
// comments are loaded and whenever a comment leaves (callback, delivery,
// retry, export), so one built or saved under a wider rule, including one
// built before a re-init, never leaves with it.
export function applyPageUrlRule(item, keepQueryParams) {
  let changed = false;
  if (typeof item?.page?.url === "string") {
    const url = pageUrlForSharing(item.page.url, keepQueryParams);
    if (url !== item.page.url) {
      item.page.url = url;
      changed = true;
    }
  }
  if (applySourceContextUrlRule(item?.sourceContext, keepQueryParams)) changed = true;
  return changed;
}

// The `keepQueryParams` init option: an array of query keys, matched exactly.
// Anything else is a configuration mistake, so warn and keep less (never more)
// than asked.
export function normalizeKeepQueryParams(value) {
  if (value === undefined) return [];
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
