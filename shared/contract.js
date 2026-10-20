// The names in what the widget writes, shared with the receiver so that both
// sides of a release read the same ones (#170). Their versions are in
// versions.js; the compatibility rules are in the README ("互換性" /
// "Compatibility").

// The kind of the export bundle (the downloaded JSON file).
export const EXPORT_BUNDLE_KIND = "patchloop-feedback-bundle";

// The sourceContext block (#96): each field, and the meta tag the widget reads
// it from when the init option does not give it.
export const SOURCE_CONTEXT_FIELDS = [
  { key: "repo", metaName: "patchloop:repo" },
  { key: "branch", metaName: "patchloop:branch" },
  { key: "commit", metaName: "patchloop:commit" },
  { key: "root", metaName: "patchloop:root" },
  { key: "buildUrl", metaName: "patchloop:build-url" },
  { key: "previewUrl", metaName: "patchloop:preview-url" }
];
export const SOURCE_CONTEXT_KEYS = SOURCE_CONTEXT_FIELDS.map(({ key }) => key);

// What a comment points at: a point, or an area.
export const TARGET_KINDS = ["point", "area"];
