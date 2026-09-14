"use strict";

function feedbackForExport(item) {
  if (!item.screenshot || !Object.hasOwn(item.screenshot, "path")) return item;
  // The receiver still needs the stored path for cleanup and file upload.
  const { path: _path, ...screenshot } = item.screenshot;
  return { ...item, screenshot };
}

module.exports = { feedbackForExport };
