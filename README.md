# PatchLoop

PatchLoop は、AI で作った demo / PoC に対してブラウザ上で直接フィードバックを残し、その内容を Slack / GitHub / AI 修正 PR につなげるための実験的プロトタイプです。

PatchLoop is an experimental prototype for collecting browser-based visual feedback on AI-generated demos and turning that feedback into Slack, GitHub, or AI repair context.

## ローカルで起動する / Run Locally

`index.html` を直接ブラウザで開くか、任意の静的ファイルサーバーで配信します。

Open `index.html` directly in a browser, or serve the folder with any static file server.

```sh
python3 -m http.server 4173
```

その後、以下を開きます。

Then visit:

```text
http://localhost:4173
```

script-tag widget の例はこちらです。

The script-tag widget example is available at:


```text
http://localhost:4173/examples/plain-html/
```

## 現在できること / What Works Now

ローカル prototype:

- Demo portal with owner, expiry, data classification, and feedback counts
- Preview screen with feedback mode
- Click-to-comment pins on the preview
- Local feedback storage via `localStorage`
- Dashboard with status triage
- Generated GitHub Issue-style payload containing URL, position, selector, viewport, browser, branch, git SHA, logs, and AI instructions

script-tag widget:

- Floating feedback launcher
- Comment mode toggle
- Click-to-pin location capture
- Drag-to-select area capture
- Comment form
- Payload generation with URL, point/area position, selector, viewport, browser, reviewer, and timestamp
- Optional `onSubmit(payload)` callback
- Optional `endpoint` setting for a future POST receiver

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
    onSubmit(payload) {
      console.log(payload);
    }
  });
</script>
```

基本操作:

1. 右下の「フィードバック」を押す
2. 「コメントモード開始」を押す
3. 画面上の場所をクリック、または範囲をドラッグする
4. コメントを書いて送信する
5. `onSubmit(payload)` で payload を受け取る

Basic flow:

1. Click the feedback launcher
2. Start comment mode
3. Click a point or drag an area on the page
4. Write and submit a comment
5. Receive the payload through `onSubmit(payload)`

## Payload

主な payload 項目:

Main payload fields:

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
- `createdAt`

`target.kind` は `point` または `area` です。範囲選択の場合は `target.area` に `x`, `y`, `width`, `height` が percentage で入ります。

`target.kind` is either `point` or `area`. For area selections, `target.area` includes `x`, `y`, `width`, and `height` as percentages.

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

このバージョンは、まだ GitHub / Slack には直接送信しません。受信したフィードバックはローカル receiver の `server/feedback.json` に保存されます。

This version does not send to GitHub or Slack directly yet. Received feedback is stored in `server/feedback.json` by the local receiver.

未対応:

Not included yet:

- Slack 投稿 / Slack delivery
- GitHub Issue 作成 / GitHub Issue creation
- 永続 DB / persistent database
- 本物の screenshot capture / real screenshot capture
- 認証 / auth
- AI PR 連携 / AI PR integration
