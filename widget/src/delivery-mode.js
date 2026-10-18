import { DEFAULTS } from "./state.js";

const DELIVERY_MODES = ["receiver", "slack-webhook", "download", "none"];

// The `deliveryMode` init option (#164). Any other value is a configuration
// mistake (a typo, most likely), so warn and use the default, as the widget
// already sent such a comment to the receiver while its settings showed none.
export function normalizeDeliveryMode(value) {
  if (value === undefined) return DEFAULTS.deliveryMode;
  if (DELIVERY_MODES.includes(value)) return value;
  console.warn(`[PatchLoop] deliveryMode must be one of ${DELIVERY_MODES.join(", ")}; using ${DEFAULTS.deliveryMode}`, value);
  return DEFAULTS.deliveryMode;
}
