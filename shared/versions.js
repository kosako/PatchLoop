// Versions of what the widget writes, shared with the receiver so that both
// sides of a release agree on the newest one (#126). The compatibility rules
// for each are in the README ("互換性" / "Compatibility").

// The feedback payload's schemaVersion. Bump when the payload shape changes.
// v1 is a payload without schemaVersion (the widget before v2).
// v2 adds the optional sourceContext block (#96).
// v3 adds screenshot.uncaptured (#148).
// v4 adds replaces, on the revision of a comment edited after it left the
// device (#121).
export const PAYLOAD_SCHEMA_VERSION = 4;

// The version of the export bundle (the downloaded JSON file). v1 wrapped a
// single feedback object; v2 carries an array (batch export).
export const EXPORT_BUNDLE_VERSION = 2;
