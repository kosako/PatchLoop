# PatchLoop

> English version: [README.en.md](./README.en.md)

PatchLoop は、AI で作った demo / PoC に対してブラウザ上で直接フィードバックを残し、その内容を Slack / GitHub / AI 修正 PR につなげるための実験的プロトタイプです。

## ローカルで起動する

任意の静的ファイルサーバーで配信して `examples/plain-html/` を開きます。

```sh
python3 -m http.server 4173
```

```text
http://localhost:4173/examples/plain-html/
```

## 現在できること

script-tag widget:

- 邪魔にならない右端ドロワー（折りたたみ時はハンドルのみ表示）
- ドロワーヘッダーのコメントモード切り替え（モード ON 中はハンドルが赤くなる）
- クリックで点キャプチャ、ドラッグで範囲キャプチャ
- 送信前はドラフト表示、送信時に 1, 2, 3 と確定番号が振られる
- ドラフト中、対象要素にダッシュドラインの outline
- ドロワー内のコメント一覧（番号 / kind / reviewer / 本文 / 配送ステータス）
- マーカーホバーでコメントのツールチップ表示（feedback モード中は無効）
- 個別の編集・削除と残りマーカーの自動再番号付け
- URL / 点・範囲位置 / selector / viewport / browser / reviewer / timestamp を含む payload
- 任意の `onSubmit(payload)` callback
- 任意の `endpoint` 設定で payload を receiver に POST

## 埋め込み Widget

PatchLoop は、普通の HTML に `script` tag で埋め込める standalone widget を含んでいます。

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

### 基本操作

1. 右端のハンドルを押して drawer を開く
2. 「コメントモード開始」を押す
3. 画面上の場所をクリック、または範囲をドラッグする
4. コメントと投稿者を書いて送信する
5. drawer の一覧に追加され、`onSubmit(payload)` でも payload を受け取る。送信済みの項目は drawer 内から個別に編集・削除できる

## Payload

主な payload 項目:

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

`clientX/clientY` は現在の viewport 上の位置、`pageX/pageY` はスクロールを含む document 上の位置です。pin / area overlay は document 上に固定されるため、スクロールしても対象箇所に追従します。

## ローカル receiver

`endpoint` を指定すると、widget は payload をその URL に POST します。検証用のローカル receiver が同梱されています。

```sh
node server/receive.js
```

- `POST /feedback` で payload を受け取り、`server/feedback.json` に追記します
- `GET /` で受信した feedback の一覧（inbox）を表示します
- `GET /feedback.json` で raw JSON を返します
- `PORT` / `HOST` env で変更可能（デフォルトは `127.0.0.1:4000`）

`examples/plain-html/` はデフォルトで `http://localhost:4000/feedback` に送信する設定です。`python3 -m http.server 4173` でページを配信した状態で receiver も起動すると、コメントが inbox に届きます。

## 現在の境界

このバージョンは、まだ GitHub / Slack には直接送信しません。受信したフィードバックはローカル receiver の `server/feedback.json` に保存されます。widget 内の一覧はメモリ保持のみで、ページをリロードすると消えます。永続化したい場合は `endpoint` 経由で receiver に送ってください。

未対応:

- Slack 投稿
- GitHub Issue 作成
- 永続 DB
- 本物の screenshot capture
- 認証
- AI PR 連携
