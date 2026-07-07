// Resolves the payload's sourceContext (#96): which repo/branch/commit the
// reviewed page was built from, so a coding agent can map feedback selectors
// back to source. The init option is the source of truth — the embedding side
// injects real values at build/deploy time. Meta tags are the fallback for
// hosts that can only stamp static HTML. The receiver's config is deliberately
// not a source: one receiver serves payloads from many previews, so a
// per-process value cannot be correct across projects.
const SOURCE_CONTEXT_FIELDS = [
  { key: "repo", metaName: "patchloop:repo" },
  { key: "branch", metaName: "patchloop:branch" },
  { key: "commit", metaName: "patchloop:commit" },
  { key: "root", metaName: "patchloop:root" },
  { key: "buildUrl", metaName: "patchloop:build-url" },
  { key: "previewUrl", metaName: "patchloop:preview-url" }
];

export function resolveSourceContext(configured, doc) {
  const options = configured && typeof configured === "object" ? configured : {};
  const context = {};
  for (const { key, metaName } of SOURCE_CONTEXT_FIELDS) {
    const value = cleanValue(options[key]) || metaContent(doc, metaName);
    if (value) context[key] = value;
  }
  return Object.keys(context).length > 0 ? context : null;
}

function metaContent(doc, metaName) {
  const node = doc.querySelector(`meta[name="${metaName}"]`);
  return node ? cleanValue(node.content) : "";
}

// Only trimmed non-empty strings count; anything else (numbers, objects, a
// blank template placeholder like "" left unfilled) is treated as absent so
// the payload never carries junk values into stored records or issues.
function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
