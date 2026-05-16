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
- `target.area`
- `target.selector`
- `target.text`
- `environment.viewport`
- `environment.browser`
- `createdAt`

`target.kind` は `point` または `area` です。範囲選択の場合は `target.area` に `x`, `y`, `width`, `height` が percentage で入ります。

`target.kind` is either `point` or `area`. For area selections, `target.area` includes `x`, `y`, `width`, and `height` as percentages.

## 現在の境界 / Current Boundary

このバージョンは、まだ GitHub / Slack / backend には送信しません。まずは script-tag widget の操作感と payload の形を検証する段階です。

This version does not send data to GitHub, Slack, or a backend yet. The current focus is validating the script-tag widget interaction and payload shape.

未対応:

Not included yet:

- GitHub Issue 作成 / GitHub Issue creation
- Slack 投稿 / Slack delivery
- backend persistence
- 本物の screenshot capture / real screenshot capture
- 認証 / auth
- AI PR 連携 / AI PR integration
