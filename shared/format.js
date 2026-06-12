// Formatting helpers shared by the widget (bundled into dist) and the
// receiver (require(ESM) from CommonJS). Environment-free by design: plain
// string/number formatting only, no DOM and no Node APIs. Receiver-specific
// link hardening (safeLinkUrl / mdLinkUrl) and the screenshot status texts
// stay in their respective owners because their semantics differ per side.

export function truncateText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function present(value) {
  return value === undefined || value === null || value === "" ? "?" : value;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeXml(value) {
  return escapeHtml(value).replaceAll("'", "&apos;");
}

export function slackEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatSlackCode(value) {
  return `\`${slackEscape(truncateText(String(value ?? "").replaceAll("`", "'"), 180))}\``;
}

export function formatSlackLink(url, label) {
  if (!/^https?:\/\//.test(url || "")) {
    return slackEscape(label || url || "(unknown)");
  }
  return `<${slackEscape(url)}|${slackEscape(truncateText(String(label || url).replaceAll("|", "/"), 120))}>`;
}

export function formatViewport(viewport) {
  if (!viewport) return "(unknown)";
  return `${present(viewport.width)}x${present(viewport.height)}`;
}

export function formatTarget(target) {
  if (target.kind === "area" && target.area) {
    return `area ${present(target.area.clientWidth)}x${present(target.area.clientHeight)} at ${present(target.area.clientX)},${present(target.area.clientY)}`;
  }
  return `${target.kind || "point"} at ${present(target.clientX)},${present(target.clientY)}`;
}
