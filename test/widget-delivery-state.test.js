"use strict";

// What each delivery state means, in one table (#153): the list's badge, the
// retry button, whether the comment has left the device (an edit then goes as
// a revision, #121), and the text of the notice and the badge's title.

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  canRetry,
  deliveryBadge,
  deliveryFailed,
  deliveryStatusText,
  hasLeftDevice,
  interruptedDelivery,
  isDelivering,
  receiverAnswered,
  receiverHasCopy
} = require("../widget/src/delivery-state.js");
const { statusLookupIds } = require("../widget/src/inbox-status.js");

const SENT = { comment: "Fix", reviewer: "Reviewer" };
const item = (delivery, extra = {}) => ({ id: "fb-1", ...SENT, ...(delivery === undefined ? {} : { delivery }), ...extra });

// badge: "tone|label|explained", or "none".
const STATES = [
  { name: "no delivery", item: item(), badge: "none", retry: false, left: false, text: "" },
  { name: "exported, no delivery", item: item(undefined, { exported: true }), badge: "none", retry: false, left: true, text: "" },
  // States the widget does not make itself (a saved list from elsewhere),
  // kept as they were before #153: which check comes first matters here.
  { name: "delivery null", item: item(null), badge: "none", retry: false, left: false, text: "" },
  { name: "delivery without a result", item: item({}), badge: "fail|送信失敗|true", retry: false, left: false, text: "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。" },
  { name: "result unknown, nothing else", item: item({ ok: null }), badge: "unknown|結果未確認|true", retry: false, left: false, text: "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。" },
  { name: "on its way, edited after an export (localEdited)", item: item({ pending: true, target: "receiver", startedAt: 1 }, { localEdited: true }), badge: "unknown|ローカル変更・送信先には未反映|false", retry: false, left: true, delivering: true, text: "送信しています…" },
  { name: "on its way", item: item({ pending: true, target: "receiver", startedAt: 1 }), badge: "unknown|送信中…|false", retry: false, left: false, delivering: true, text: "送信しています…" },
  { name: "received", item: item({ ok: true, status: 201, sent: SENT }), badge: "ok|送信済み|true", retry: false, left: true, answered: true, text: "受信箱に送信しました。" },
  { name: "refused by the receiver", item: item({ ok: false, status: 500 }), badge: "fail|送信失敗|true", retry: true, left: false, failed: true, text: "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。" },
  { name: "not reached", item: item({ ok: false, error: "Failed to fetch" }), badge: "fail|送信失敗|true", retry: true, left: false, failed: true, text: "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。" },
  { name: "id already received (409)", item: item({ ok: false, status: 409 }), badge: "fail|送信失敗|true", retry: false, left: true, answered: true, failed: true, text: "同じ ID が受信済みです。受信箱の内容を確認してください。" },
  { name: "cut off on the way", item: item({ ok: null, interrupted: true, target: "receiver" }), badge: "unknown|結果未確認|true", retry: true, left: true, text: "送信が中断されたため、結果は未確認です。受信箱の内容を確認してから再送してください。" },
  { name: "too long to send", item: item({ ok: false, tooLong: true, target: "receiver" }), badge: "fail|送信失敗|true", retry: true, left: false, failed: true, text: "コメントか投稿者名が長すぎるため、送っていません。編集で 20,000 文字以内にしてから再送してください。" },
  { name: "posted to Slack blind", item: item({ ok: null, status: "unknown", target: "slack-webhook" }), badge: "unknown|結果未確認|true", retry: false, left: true, slackCopy: true, text: "Slack への送信を開始しました。ブラウザから送信結果は確認できません。" },
  { name: "cut off on the way to Slack", item: item({ ok: null, interrupted: true, target: "slack-webhook" }), badge: "unknown|結果未確認|true", retry: false, left: true, slackCopy: true, text: "送信が中断されました。Slack 側で内容を確認してください。再送すると重複する可能性があります。" },
  { name: "not posted to Slack", item: item({ ok: false, target: "slack-webhook", error: "Failed to fetch" }), badge: "fail|送信失敗|true", retry: true, left: false, failed: true, text: "Slack に送信できませんでした。送信先・設定を確認してください。" },
  { name: "downloaded, before batch export", item: item({ ok: true, target: "download", fileName: "fb-1.json" }), badge: "ok|送信済み|true", retry: false, left: true, answered: true, text: "downloaded fb-1.json" },
  { name: "download failed, before batch export", item: item({ ok: false, target: "download", error: "blocked" }), badge: "fail|送信失敗|true", retry: true, left: false, failed: true, text: "download failed: blocked" },
  { name: "received, then edited here", item: item({ ok: true, status: 201, sent: { comment: "Old", reviewer: "Reviewer" } }), badge: "unknown|ローカル変更・送信先には未反映|false", retry: false, left: true, answered: true, text: "受信箱に送信しました。" },
  { name: "failed, edited after an export (localEdited)", item: item({ ok: false, status: 500 }, { localEdited: true }), badge: "unknown|ローカル変更・送信先には未反映|false", retry: false, left: true, failed: true, text: "送信できませんでした。コメントはこの端末に残っています。送信先・接続を確認してください。" }
];

function badgeOf(entry) {
  const badge = deliveryBadge(entry);
  return badge ? `${badge.tone}|${badge.label}|${badge.explained}` : "none";
}

for (const state of STATES) {
  test(`delivery state: ${state.name}`, () => {
    assert.equal(badgeOf(state.item), state.badge, "badge");
    assert.equal(canRetry(state.item), state.retry, "retry");
    assert.equal(hasLeftDevice(state.item), state.left, "left the device");
    assert.equal(isDelivering(state.item), state.delivering ?? false, "on its way");
    assert.equal(receiverAnswered(state.item.delivery), state.answered ?? false, "the receiver answered it holds it");
    assert.equal(receiverHasCopy(state.item.delivery), Boolean(state.answered || state.slackCopy), "the receiver may hold it");
    assert.equal(deliveryFailed(state.item.delivery), state.failed ?? false, "an error notice");
    assert.equal(deliveryStatusText(state.item.delivery, 20_000), state.text, "text");
  });
}

test("the status lookup asks for the comments the receiver answered it holds", () => {
  const ids = statusLookupIds(STATES.map((state, index) => ({ ...state.item, id: `fb-${index}` })));
  const expected = STATES.map((state, index) => (state.answered ? `fb-${index}` : null)).filter(Boolean);
  assert.equal(ids.join(","), expected.join(","));
});

test("a delivery given up keeps only where it was going", () => {
  assert.equal(JSON.stringify(interruptedDelivery({ pending: true, target: "slack-webhook", startedAt: 1 })), '{"ok":null,"interrupted":true,"target":"slack-webhook"}');
  assert.equal(JSON.stringify(interruptedDelivery({ pending: true, target: "receiver", startedAt: 1 })), '{"ok":null,"interrupted":true,"target":"receiver"}');
});
