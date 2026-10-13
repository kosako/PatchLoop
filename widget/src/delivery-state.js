// What a comment's delivery state says about the copy the receiver (or Slack)
// holds.

// Whether the receiver may hold the comment: it took the post, or answered 409
// (it already had that id), or Slack was posted to blind.
export function receiverHasCopy(delivery) {
  return delivery?.ok === true || delivery?.status === 409 || (delivery?.target === "slack-webhook" && delivery.ok === null);
}

// Whether the comment here differs from what the receiver may hold: edited
// here after it went out or was exported (#187), or edited in another tab
// while it was on its way, as delivery.sent keeps the text that went out
// (#139). The merge with other tabs keeps the result and the text apart, so
// this is decided on what the merge leaves.
export function isLocallyEdited(item) {
  if (item.localEdited) return true;
  const sent = item.delivery?.sent;
  return Boolean(sent) && receiverHasCopy(item.delivery) && (sent.comment !== item.comment || sent.reviewer !== item.reviewer);
}

// How long ago another tab's delivery started, as far as this tab can tell
// (#139): from its start time when that is not ahead of this clock (now), else
// (the clock was set back) from when this tab first saw it (seen), both on a
// monotonic clock (monotonicNow). Infinity for one saved without a start time.
export function pendingAge(startedAt, now, seen, monotonicNow) {
  if (typeof startedAt !== "number") return Infinity;
  return startedAt <= now ? now - startedAt : monotonicNow - seen;
}
