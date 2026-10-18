import { formatCount } from "../../shared/format.js";

// What a comment's delivery state says about the copy the receiver (or Slack)
// holds, and what the list and the notices show and offer for it. What a
// state means is decided only here, so a new state changes one place (#153).

// Whether the receiver answered that it holds the comment: it took the post,
// or refused it as an id it already had (409).
export function receiverAnswered(delivery) {
  return delivery?.ok === true || delivery?.status === 409;
}

// Whether the receiver may hold the comment: it answered so, or Slack was
// posted to blind.
export function receiverHasCopy(delivery) {
  return receiverAnswered(delivery) || (delivery?.target === "slack-webhook" && delivery.ok === null);
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

// Whether the comment has left this device: exported, or the receiver (or
// Slack) may hold it, including a delivery cut off before its answer, or
// edited here after it did (localEdited, before #121).
export function hasLeftDevice(item) {
  return Boolean(item.exported || item.localEdited || item.delivery?.interrupted || receiverHasCopy(item.delivery));
}

// Whether a delivery is on its way, from this tab or another (#139): the
// comment is neither edited nor deleted meanwhile, nor the list cleared.
export function isDelivering(item) {
  return Boolean(item.delivery?.pending);
}

// A delivery given up before its answer (#139): the receiver may hold the
// comment, or may not.
export function interruptedDelivery(delivery) {
  return { ok: null, interrupted: true, target: delivery.target };
}

// Whether the delivery failed: its notice tells so as an error.
export function deliveryFailed(delivery) {
  return delivery?.ok === false;
}

// A failed delivery, or an interrupted one to the receiver (Slack may have it
// already), of a comment the receiver does not hold in another text.
export function canRetry(item) {
  return Boolean((item.delivery?.ok === false || (item.delivery?.interrupted && item.delivery.target !== "slack-webhook")) && !isLocallyEdited(item) && item.delivery.status !== 409);
}

// The list's badge: its tone (the class it takes), its label, and whether its
// title tells the result (deliveryStatusText). null without a delivery.
export function deliveryBadge(item) {
  if (isLocallyEdited(item)) return { tone: "unknown", label: "ローカル変更・送信先には未反映", explained: false };
  if (isDelivering(item)) return { tone: "unknown", label: "送信中…", explained: false };
  if (!item.delivery) return null;
  if (item.delivery.ok === null) return { tone: "unknown", label: "結果未確認", explained: true };
  if (item.delivery.ok) return { tone: "ok", label: "送信済み", explained: true };
  return { tone: "fail", label: "送信失敗", explained: true };
}

export function tooLongToSendText(maxFieldLength) {
  return `コメントか投稿者名が長すぎるため、送っていません。編集で ${formatCount(maxFieldLength)} 文字以内にしてから再送してください。`;
}

// What came of a delivery, for the notice and the badge's title.
// maxFieldLength: the limit a comment held as too long is to fit (#196).
export function deliveryStatusText(delivery, maxFieldLength) {
  if (!delivery) return "";
  if (delivery.pending) return "送信しています…";
  if (delivery.interrupted) return delivery.target === "slack-webhook"
    ? "送信が中断されました。Slack 側で内容を確認してください。再送すると重複する可能性があります。"
    : "送信が中断されたため、結果は未確認です。受信箱の内容を確認してから再送してください。";
  if (delivery.tooLong) return tooLongToSendText(maxFieldLength);
  if (delivery.target === "download") {
    if (delivery.ok) return `downloaded ${delivery.fileName || ""}`.trim();
    return `download failed: ${delivery.error || "unknown error"}`;
  }
  if (delivery.target === "slack-webhook") {
    if (delivery.ok === null) return "Slack への送信を開始しました。ブラウザから送信結果は確認できません。";
    if (delivery.ok) return "Slack に送信しました。";
    return "Slack に送信できませんでした。送信先・設定を確認してください。";
  }
  if (delivery.ok) return "受信箱に送信しました。";
  if (delivery.status === 409) return "同じ ID が受信済みです。受信箱の内容を確認してください。";
  return "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。";
}

// How long ago another tab's delivery started, as far as this tab can tell
// (#139): from its start time when that is not ahead of this clock (now), else
// (the clock was set back) from when this tab first saw it (seen), both on a
// monotonic clock (monotonicNow). Infinity for one saved without a start time.
export function pendingAge(startedAt, now, seen, monotonicNow) {
  if (typeof startedAt !== "number") return Infinity;
  return startedAt <= now ? now - startedAt : monotonicNow - seen;
}
