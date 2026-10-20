// The marks the widget keeps with a comment on the device only, shared with
// the receiver so that both sides drop the same ones (#170): the widget leaves
// them out of what it sends and exports, and the receiver drops them when a
// producer sends them anyway (an older widget, or another producer). The
// README lists them with the fields the receiver does not store.
//
// delivery: the delivery state, whose sent text may be an older one, past the
// limit the comment now fits (#196). exported, exportedAt, exportedFileName:
// the export marks. previousIds: the ids a revision replaced (#121).
// localEdited: the edited-after-sending mark of comments saved before #121.
export const LOCAL_ONLY_KEYS = ["delivery", "exported", "exportedAt", "exportedFileName", "previousIds", "localEdited"];

// In screenshot: the mark of a saved copy that left out the image data to fit
// the storage.
export const LOCAL_ONLY_SCREENSHOT_KEYS = ["persistedWithoutDataUrl"];

// A comment as it leaves the device: a copy without the marks above. The parts
// it does not change are shared with the comment.
export function toWireFeedback(item) {
  const copy = { ...item };
  LOCAL_ONLY_KEYS.forEach((key) => delete copy[key]);
  const screenshot = copy.screenshot;
  if (screenshot && LOCAL_ONLY_SCREENSHOT_KEYS.some((key) => Object.hasOwn(screenshot, key))) {
    copy.screenshot = { ...screenshot };
    LOCAL_ONLY_SCREENSHOT_KEYS.forEach((key) => delete copy.screenshot[key]);
  }
  return copy;
}
