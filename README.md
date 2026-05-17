# PatchLoop

PatchLoop は、AI で作った demo / PoC に対してブラウザ上で直接フィードバックを残し、その内容を Slack / GitHub / AI 修正 PR につなげるための実験的プロトタイプです。

PatchLoop is an experimental prototype for collecting browser-based visual feedback on AI-generated demos and turning that feedback into Slack, GitHub, or AI repair context.

## ローカルで起動する / Run Locally

任意の静的ファイルサーバーで配信して `examples/plain-html/` を開きます。

Serve the folder with any static file server and open `examples/plain-html/`.

```sh
python3 -m http.server 4173
```

```text
http://localhost:4173/examples/plain-html/
```

## 現在できること / What Works Now

script-tag widget:

- Right-edge drawer with collapse handle that stays out of the way
- Comment mode toggle in the drawer header (active state colours the handle)
- Click-to-pin location capture and drag-to-select area capture
- Draft markers that take their final sequential number on submit
- Target element outline while a draft is pending
- Per-feedback comment list with reviewer, kind, comment, and delivery status
- Hover tooltip on markers showing the comment (disabled in feedback mode)
- Per-item edit and delete inside the drawer with marker renumbering
- Payload with URL, point/area position, selector, viewport, browser, reviewer, and timestamp
- Optional `onSubmit(payload)` callback
- Optional `endpoint` setting that POSTs payloads to the bundled local receiver

## 埋め込み Widget / Embeddable Widget

PatchLoop は、普通の HTML に `script` tag で埋め込める standalone widget を含んでいます。

PatchLoop includes a standalone widget that can be embedded into a normal HTML page with a `script` tag.

```html
<script src="../../widget/patchloop-widget.js"></script>
<script>
  window.PatchLoop.init({
    projectId: "patchloop",
    demoId: "plain-html-renewal-review",
    reviewer: "Kosako",
    endpoint: "http://localhost:4000/feedback",
    onSubmit(payload) {
      console.log(payload);
    }
  });
</script>
```

### Init options

- `projectId` (string) — payload に乗せるプロジェクト識別子
- `demoId` (string) — payload に乗せるデモ識別子
- `reviewer` (string, optional) — コメントフォームに初期表示する投稿者名
- `endpoint` (string, optional) — payload を `POST` する URL。未設定なら送信しない
- `onSubmit(payload)` (function, optional) — submit のたびに呼ばれる callback

### window.PatchLoop API

- `PatchLoop.init(options)` — widget をマウントしてキャプチャを開始
- `PatchLoop.destroy()` — widget DOM・マーカー・ハイライトを全部撤去
- `PatchLoop.setFeedbackMode(boolean)` — コメントモードを外部から切替
- `PatchLoop.getFeedback()` — 現在の feedback 一覧のコピーを返す（newest first）

### Events

submit のたびに `document` で `patchloop:feedback` が発火し、`event.detail` に payload が入ります。`endpoint` の POST が終わるのを待たずに呼ばれます。

基本操作:

1. 右端のハンドルを押して drawer を開く
2. 「コメントモード開始」を押す
3. 画面上の場所をクリック、または範囲をドラッグする
4. コメントと投稿者を書いて送信する
5. drawer の一覧に追加され、`onSubmit(payload)` でも payload を受け取る。送信済みの項目は drawer 内から個別に編集・削除できる

Basic flow:

1. Click the right-edge handle to open the drawer
2. Start comment mode
3. Click a point or drag an area on the page
4. Write a comment and reviewer name, then submit
5. The comment appears in the drawer list and is also passed to `onSubmit(payload)`. Each item can be edited or deleted from the list

## Payload

主な payload 項目:

Main payload fields:

- `id`
- `projectId`
- `demoId`
- `comment`
- `reviewer`
- `page.url`
- `page.title`
- `target.kind`
- `target.x`
- `target.y`
- `target.clientX`
- `target.clientY`
- `target.pageX`
- `target.pageY`
- `target.documentX`
- `target.documentY`
- `target.area`
- `target.selector`
- `target.text`
- `environment.viewport`
- `environment.browser`
- `environment.language`
- `createdAt`
- `delivery` — `endpoint` 設定時、POST 完了後に `{ ok, status }` または `{ ok: false, error }` が追加される

`target.kind` は `point` または `area` です。範囲選択の場合は `target.area` に viewport 上の percentage (`x` / `y` / `width` / `height`) に加えて、`clientX/Y/Width/Height`、`pageX/Y`、`documentX/Y/Width/Height` のピクセル値も入ります。

`target.kind` is either `point` or `area`. For area selections, `target.area` carries the viewport percentages (`x` / `y` / `width` / `height`) plus pixel values for `clientX/Y/Width/Height`, `pageX/Y`, and `documentX/Y/Width/Height`.

`clientX/clientY` は現在の viewport 上の位置、`pageX/pageY` はスクロールを含む document 上の位置です。pin / area overlay は document 上に固定されるため、スクロールしても対象箇所に追従します。

`clientX/clientY` represent viewport coordinates, while `pageX/pageY` represent document coordinates including scroll. Pins and area overlays are anchored to document coordinates so they stay attached to the target while scrolling.

## ローカル receiver / Local Receiver

`endpoint` を指定すると、widget は payload をその URL に POST します。検証用のローカル receiver が同梱されています。

When `endpoint` is set, the widget POSTs the payload to that URL. A local receiver is bundled for testing.

```sh
node server/receive.js
```

- `POST /feedback` で payload を受け取り、`server/feedback.json` に追記します
- `GET /` で受信した feedback の一覧（inbox）を表示します
- `GET /feedback.json` で raw JSON を返します
- `PORT` / `HOST` env で変更可能（デフォルトは `127.0.0.1:4000`）

- Accepts payload at `POST /feedback`, appends to `server/feedback.json`
- Renders an inbox of received feedback at `GET /`
- Returns the raw JSON at `GET /feedback.json`
- Configurable via `PORT` / `HOST` env (default `127.0.0.1:4000`)

`examples/plain-html/` はデフォルトで `http://localhost:4000/feedback` に送信する設定です。`python3 -m http.server 4173` でページを配信した状態で receiver も起動すると、コメントが inbox に届きます。

`examples/plain-html/` is preconfigured to send to `http://localhost:4000/feedback`. Serve the page with `python3 -m http.server 4173`, start the receiver alongside it, and submitted comments will appear in the inbox.

## 現在の境界 / Current Boundary

このバージョンは、まだ GitHub / Slack には直接送信しません。受信したフィードバックはローカル receiver の `server/feedback.json` に保存されます。widget 内の一覧はメモリ保持のみで、ページをリロードすると消えます。永続化したい場合は `endpoint` 経由で receiver に送ってください。

This version does not send to GitHub or Slack directly yet. Received feedback is stored in `server/feedback.json` by the local receiver. The drawer list inside the widget is kept in memory only and is cleared on reload — wire up `endpoint` if you need persistence.

未対応:

Not included yet:

- Slack 投稿 / Slack delivery
- GitHub Issue 作成 / GitHub Issue creation
- 永続 DB / persistent database
- 本物の screenshot capture / real screenshot capture
- 認証 / auth
- AI PR 連携 / AI PR integration
