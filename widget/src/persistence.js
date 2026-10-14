import { state } from "./state.js";
import { applyPageUrlRule, normalizePageUrl, pageUrlForSharing, samePersistedPage } from "./url.js";
import { feedbackFingerprints, mergeFeedbackLists } from "./tab-sync.js";

export const FEEDBACK_STORAGE_VERSION = 1;

export function loadStoredReviewer(storageKey) {
  if (!storageKey) return "";
  try {
    return String(window.localStorage.getItem(storageKey) || "").trim();
  } catch (_) {
    return "";
  }
}

export function saveReviewer(reviewer) {
  state.options.reviewer = reviewer;
  if (!state.options.reviewerStorageKey) return;
  try {
    window.localStorage.setItem(state.options.reviewerStorageKey, reviewer);
  } catch (_) {
    // Storage can be unavailable in privacy-restricted contexts.
  }
}

// The marker display mode (#147) is a viewer preference, so it is kept per
// origin rather than per project / demo / page like the feedback list.
const DISPLAY_MODE_STORAGE_KEY = "patchloop:display-mode";
const DISPLAY_MODES = ["normal", "dots", "all"];

export function loadDisplayMode() {
  try {
    const stored = window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
    return DISPLAY_MODES.includes(stored) ? stored : "normal";
  } catch (_) {
    return "normal";
  }
}

export function saveDisplayMode(mode) {
  try {
    window.localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
  } catch (_) {
    // Storage can be unavailable in privacy-restricted contexts.
  }
}

// Also notes which comments were in storage, for the merge with other tabs.
export function loadPersistedFeedback() {
  const list = readPersistedFeedback();
  state.storedFeedback = fingerprintsOf(list);
  return list;
}

function readPersistedFeedback() {
  if (!state.options.feedbackStorageKey) return [];

  try {
    const storageKey = feedbackScope().key;
    const scoped = window.localStorage.getItem(storageKey);
    const raw = scoped ?? window.localStorage.getItem(state.options.feedbackStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!isMatchingFeedbackEnvelope(parsed)) return [];
    // Data saved before #163 or under a wider keepQueryParams carries more of
    // the URL: trim it and write the result back where it was read from.
    const stored = trimEnvelopeUrls(parsed) ? JSON.stringify(parsed) : raw;
    if (scoped === null) {
      try {
        // Keep the only legacy copy until the scoped write succeeds, including
        // when a full localStorage prevents temporarily holding both copies.
        window.localStorage.setItem(storageKey, stored);
        window.localStorage.removeItem(state.options.feedbackStorageKey);
      } catch (error) {
        console.warn("[PatchLoop] legacy feedback migration deferred", error);
        if (stored !== raw) rewriteStoredEnvelope(state.options.feedbackStorageKey, stored);
      }
    } else if (stored !== raw) {
      rewriteStoredEnvelope(storageKey, stored);
    }
    return Array.isArray(parsed.feedback)
      ? parsed.feedback.map(normalizePersistedFeedback).filter(Boolean)
      : [];
  } catch (error) {
    console.warn("[PatchLoop] persisted feedback ignored", error);
    return [];
  }
}

// Trims the envelope's pageUrl to the page identity and each comment's
// page.url to the current keepQueryParams, in place; true when anything changed.
function trimEnvelopeUrls(envelope) {
  let changed = false;
  const pageUrl = pageUrlForSharing(envelope.pageUrl, []);
  if (pageUrl !== envelope.pageUrl) {
    envelope.pageUrl = pageUrl;
    changed = true;
  }
  envelope.feedback.forEach((item) => {
    if (applyPageUrlRule(item, state.options.keepQueryParams)) changed = true;
  });
  return changed;
}

// Replacing a value with a shorter one, so this normally fits even when the
// storage is full; if it still fails, the old copy stays as it was.
function rewriteStoredEnvelope(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn("[PatchLoop] unable to trim saved page URLs", error);
  }
}

// Saves the list after merging what another tab of the page saved since this
// tab last read or wrote it (#139); what this tab changed of a comment
// meanwhile wins. The merge can add or remove comments: the caller updates the
// markers from the returned { added, removed }.
export function persistFeedbackList() {
  if (!state.options.persistFeedback || !state.options.feedbackStorageKey) return noChanges();

  const changes = mergeStoredFeedback("ours");
  const envelope = feedbackStorageEnvelope(state.feedback);
  const storageKey = feedbackScope().key;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(envelope));
    state.storedFeedback = fingerprintsOf(envelope.feedback);
  } catch (error) {
    const compactEnvelope = feedbackStorageEnvelope(state.feedback, { omitScreenshotDataUrl: true });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(compactEnvelope));
      state.storedFeedback = fingerprintsOf(compactEnvelope.feedback);
      console.warn("[PatchLoop] persisted feedback without screenshot dataUrl", error);
    } catch (retryError) {
      console.warn("[PatchLoop] unable to persist feedback", retryError);
    }
  }
  return changes;
}

// Takes in what another tab of the page saved (#139); its version of a comment
// wins, except the delivery state of one this tab is delivering. changed tells
// whether the list differs at all afterwards.
export function syncPersistedFeedback() {
  if (!state.options.persistFeedback || !state.options.feedbackStorageKey) return noChanges();
  const before = listSignature(state.feedback);
  const changes = mergeStoredFeedback("stored");
  return { ...changes, changed: listSignature(state.feedback) !== before };
}

function listSignature(feedback) {
  return JSON.stringify(feedback.map((item) => [item.id, feedbackFingerprints(item)]));
}

// Whether a storage change is to this page's saved list; a null key is a clear().
export function isOwnFeedbackKey(key) {
  return key === null || key === feedbackScope().key || key === state.options.feedbackStorageKey;
}

function mergeStoredFeedback(prefer) {
  const stored = readStoredFeedback();
  // Unreadable: nothing tells what another tab did, so the list stays as it is.
  if (!stored) return noChanges();
  const { list, added, removed } = mergeFeedbackLists(state.feedback, stored, state.storedFeedback, { prefer, keepDelivery: state.deliveringIds });
  state.feedback = list;
  state.storedFeedback = fingerprintsOf(stored);
  return { added, removed };
}

// The page's saved comments as loading reads them, without the load's
// rewrites; [] when none are saved, null when what is saved cannot be read.
function readStoredFeedback() {
  try {
    const scoped = window.localStorage.getItem(feedbackScope().key);
    const legacy = scoped === null ? window.localStorage.getItem(state.options.feedbackStorageKey) : null;
    const raw = scoped ?? legacy;
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!isMatchingFeedbackEnvelope(parsed)) {
      // The legacy key holds one page's list, maybe another page's.
      return scoped === null && isDemoFeedbackEnvelope(parsed) ? [] : null;
    }
    // As loading reads it (#163), so a trim whose write-back failed does not
    // look like another tab's change.
    trimEnvelopeUrls(parsed);
    return parsed.feedback.map(normalizePersistedFeedback).filter(Boolean);
  } catch (error) {
    console.warn("[PatchLoop] saved feedback unreadable; other tabs' changes not merged", error);
    return null;
  }
}

function fingerprintsOf(feedback) {
  return new Map(feedback.filter(Boolean).map((item) => [item.id, feedbackFingerprints(item)]));
}

function noChanges() {
  return { added: [], removed: [], changed: false };
}

export function clearPersistedFeedback() {
  if (!state.options.feedbackStorageKey) return;

  try {
    window.localStorage.removeItem(feedbackScope().key);
    state.storedFeedback = new Map();
    const legacy = window.localStorage.getItem(state.options.feedbackStorageKey);
    if (legacy && isMatchingFeedbackEnvelope(JSON.parse(legacy))) {
      window.localStorage.removeItem(state.options.feedbackStorageKey);
    }
  } catch (_) {
    // Storage can be unavailable in privacy-restricted contexts.
  }
}

// The page whose saved list is in memory (#197). init fixes it as it loads
// the list, so a single-page app that changes the URL without re-initializing
// keeps saving that list under its own page instead of over another page's,
// and an export still tells it apart from the other pages.
export function bindFeedbackScope() {
  state.feedbackScope = currentFeedbackScope();
}

function feedbackScope() {
  return state.feedbackScope || currentFeedbackScope();
}

function currentFeedbackScope() {
  return { key: scopedFeedbackStorageKey(window.location.href), pageUrl: pageUrlForSharing(window.location.href, []) };
}

function scopedFeedbackStorageKey(pageUrl) {
  return `${state.options.feedbackStorageKey}:${JSON.stringify([
    state.options.projectId,
    state.options.demoId,
    normalizePageUrl(pageUrl, undefined)
  ])}`;
}

function feedbackStorageEnvelope(feedback, options = {}) {
  return {
    version: FEEDBACK_STORAGE_VERSION,
    projectId: state.options.projectId,
    demoId: state.options.demoId,
    // Only the page identity is compared on load, so no query is kept (#163).
    pageUrl: feedbackScope().pageUrl,
    savedAt: new Date().toISOString(),
    feedback: feedback.map((item) => serializeFeedbackForStorage(item, options)).filter(Boolean)
  };
}

export function serializeFeedbackForStorage(item, options = {}) {
  try {
    const copy = JSON.parse(JSON.stringify(item));
    if (options.omitScreenshotDataUrl && copy.screenshot) {
      delete copy.screenshot.dataUrl;
      copy.screenshot.persistedWithoutDataUrl = true;
    }
    return copy;
  } catch (_) {
    return null;
  }
}

export function normalizePersistedFeedback(item) {
  if (!item || typeof item !== "object") return null;
  if (!item.id || !item.target || typeof item.target !== "object") return null;
  return item;
}

export function isMatchingFeedbackEnvelope(value) {
  return isDemoFeedbackEnvelope(value) && samePersistedPage(value.pageUrl, feedbackScope().pageUrl);
}

// An envelope saved by any page of the current project / demo.
function isDemoFeedbackEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== FEEDBACK_STORAGE_VERSION) return false;
  if (value.projectId !== state.options.projectId) return false;
  if (value.demoId !== state.options.demoId) return false;
  return Array.isArray(value.feedback);
}

// The comments saved on this device by the other pages of the project / demo
// (#197), so an export can take them along: [{ key, envelope, feedback }],
// where feedback holds the envelope's own valid items. URLs are trimmed to the
// current rule (#163) in memory; saveOtherPageFeedback writes them back.
export function loadOtherPagesFeedback() {
  if (!state.options.persistFeedback || !state.options.feedbackStorageKey) return [];
  const prefix = `${state.options.feedbackStorageKey}:`;
  const ownKey = feedbackScope().key;
  let keys;
  try {
    const storage = window.localStorage;
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  } catch (error) {
    console.warn("[PatchLoop] saved feedback of other pages unavailable", error);
    return [];
  }
  const scoped = keys.flatMap((key) => {
    if (typeof key !== "string" || !key.startsWith(prefix) || key === ownKey || !isDemoScope(key.slice(prefix.length))) return [];
    return otherPageFeedback(key, () => true);
  });
  // A list saved under the legacy single key, before the per-page keys, is
  // its page's until that page is opened and migrates it; a per-page list of
  // that page wins over it, as it does on load.
  const legacy = otherPageFeedback(state.options.feedbackStorageKey, (envelope) => {
    const pageKey = scopedFeedbackStorageKey(envelope.pageUrl);
    return pageKey !== ownKey && window.localStorage.getItem(pageKey) === null;
  });
  return [...scoped, ...legacy];
}

function otherPageFeedback(key, belongsToOtherPage) {
  try {
    const envelope = JSON.parse(window.localStorage.getItem(key));
    if (!isDemoFeedbackEnvelope(envelope) || !belongsToOtherPage(envelope)) return [];
    trimEnvelopeUrls(envelope);
    return [{ key, envelope, feedback: envelope.feedback.map(normalizePersistedFeedback).filter(Boolean) }];
  } catch (error) {
    console.warn("[PatchLoop] saved feedback of another page ignored", key, error);
    return [];
  }
}

// Whether a storage change can touch the saved feedback of the project / demo;
// a null key is a clear().
export function isDemoFeedbackKey(key) {
  const base = state.options.feedbackStorageKey;
  if (key === null) return true;
  if (!base || typeof key !== "string") return false;
  return key === base || (key.startsWith(`${base}:`) && isDemoScope(key.slice(base.length + 1)));
}

// The scope part of a scoped key: [projectId, demoId, page].
function isDemoScope(scope) {
  try {
    const parts = JSON.parse(scope);
    // Compared as serialized, the way scopedFeedbackStorageKey wrote them.
    return Array.isArray(parts) && parts.length === 3
      && JSON.stringify(parts.slice(0, 2)) === JSON.stringify([state.options.projectId, state.options.demoId]);
  } catch (_) {
    return false;
  }
}

export function saveOtherPageFeedback(page) {
  page.envelope.savedAt = new Date().toISOString();
  try {
    window.localStorage.setItem(page.key, JSON.stringify(page.envelope));
  } catch (error) {
    console.warn("[PatchLoop] unable to save another page's feedback", page.key, error);
  }
}
