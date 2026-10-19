"use strict";

// How the receiver writes request-supplied values into the inbox, Markdown
// (GitHub) and Slack. Pure functions, required by receive.js and by
// inbox-view.js (#170), so the view does not take them from the entry module.

const { present } = require("../shared/format.js");

// escapeHtml cannot stop a javascript: URL inside an href attribute; only
// plain http(s) targets may become links. Returns "" for everything else.
function safeLinkUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

// Markdown link destinations are wrapped in <> so spaces and parentheses
// cannot terminate the link; encode the characters that end the <> form so
// user-controlled URLs cannot break out into raw markdown.
function mdLinkUrl(value) {
  const url = safeLinkUrl(value);
  if (!url) return "";
  return `<${url.replaceAll("<", "%3C").replaceAll(">", "%3E").replace(/\s/g, "%20")}>`;
}

function formatScreenshotStatus(screenshot) {
  if (!screenshot) return "none";
  if (screenshot.status === "omitted" && screenshot.reason === "too-large") {
    return `omitted: ${present(screenshot.bytes)} bytes exceeds ${present(screenshot.maxBytes)}`;
  }
  if (screenshot.status === "saved") {
    return `saved (${present(screenshot.bytes)} bytes)`;
  }
  return screenshot.status || "unknown";
}

module.exports = { safeLinkUrl, mdLinkUrl, formatScreenshotStatus };
