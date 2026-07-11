import { state } from "./state.js";
import { samePersistedPage } from "./url.js";

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

export function loadPersistedFeedback() {
  if (!state.options.feedbackStorageKey) return [];

  try {
    const raw = window.localStorage.getItem(state.options.feedbackStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!isMatchingFeedbackEnvelope(parsed)) return [];
    return Array.isArray(parsed.feedback)
      ? parsed.feedback.map(normalizePersistedFeedback).filter(Boolean)
      : [];
  } catch (error) {
    console.warn("[PatchLoop] persisted feedback ignored", error);
    return [];
  }
}

export function persistFeedbackList() {
  if (!state.options.persistFeedback || !state.options.feedbackStorageKey) return;

  const envelope = feedbackStorageEnvelope(state.feedback);
  try {
    window.localStorage.setItem(state.options.feedbackStorageKey, JSON.stringify(envelope));
  } catch (error) {
    const compactEnvelope = feedbackStorageEnvelope(state.feedback, { omitScreenshotDataUrl: true });
    try {
      window.localStorage.setItem(state.options.feedbackStorageKey, JSON.stringify(compactEnvelope));
      console.warn("[PatchLoop] persisted feedback without screenshot dataUrl", error);
    } catch (retryError) {
      console.warn("[PatchLoop] unable to persist feedback", retryError);
    }
  }
}

export function clearPersistedFeedback() {
  if (!state.options.feedbackStorageKey) return;

  try {
    window.localStorage.removeItem(state.options.feedbackStorageKey);
  } catch (_) {
    // Storage can be unavailable in privacy-restricted contexts.
  }
}

function feedbackStorageEnvelope(feedback, options = {}) {
  return {
    version: FEEDBACK_STORAGE_VERSION,
    projectId: state.options.projectId,
    demoId: state.options.demoId,
    pageUrl: window.location.href,
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== FEEDBACK_STORAGE_VERSION) return false;
  if (value.projectId !== state.options.projectId) return false;
  if (value.demoId !== state.options.demoId) return false;
  if (!samePersistedPage(value.pageUrl, window.location.href)) return false;
  return Array.isArray(value.feedback);
}
