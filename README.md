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

## 開発

依存を入れます。

```sh
npm install
```

lint と test を実行します。

```sh
npm run lint
npm test
npm run check
```

`npm test` は Node.js の test runner でローカル receiver を一時ポートに起動し、`/feedback` と `/import` の保存・検証・screenshot 処理を確認します。テストデータは OS の一時ディレクトリに作られ、終了時に削除されます。

## 現在できること

script-tag widget:

- 邪魔にならない右端ドロワー（折りたたみ時はハンドルのみ表示）
- ドロワーヘッダーのコメントモード切り替え（モード ON 中はハンドルが赤くなる）
- クリックで点キャプチャ、ドラッグで範囲キャプチャ
- 送信前はドラフト表示、送信時に 1, 2, 3 と確定番号が振られる
- 送信後もコメントモードは継続し、連続でコメントできる
- コメント入力中は Cmd+Enter（Windows は Ctrl+Enter）で送信
- ドラフト中、対象要素にダッシュドラインの outline
- ドロワー内のコメント一覧（番号 / kind / reviewer / 本文 / 配送ステータス）
- マーカーホバーでコメントのツールチップ表示（feedback モード中は無効）
- 個別の編集・削除と残りマーカーの自動再番号付け
- URL / 点・範囲位置 / selector / viewport / browser / reviewer / timestamp を含む payload
- viewport の lightweight screenshot snapshot（SVG）を payload に添付
- feedback list の `localStorage` 永続化と reload 後の pin / area overlay 復元
- ウィンドウリサイズ時は selector で対象要素を引き直し、pin / area を要素に追従して再配置
- 再配置できない場合（要素が見つからない・非表示など）は従来座標のまま、marker と一覧に近似表示（≈）
- 任意の `onSubmit(payload)` callback
- 任意の `endpoint` 設定で payload を receiver に POST
- ローカル receiver から任意の Slack Incoming Webhook へ、スクショリンク / image block / 任意の file upload 付きで転送
- Download mode で 1 feedback ごとの versioned JSON bundle を保存
- receiver inbox から download mode の bundle を import
- 設定または drawer UI から、receiver 経由送信 / Slack webhook 直送 / download / 送信なしを切り替え

## 埋め込み Widget

PatchLoop は、普通の HTML に `script` tag で埋め込める standalone widget を含んでいます。

```html
<script src="../../widget/patchloop-widget.js"></script>
<script>
  window.PatchLoop.init({
    projectId: "patchloop",
    demoId: "plain-html-renewal-review",
    endpoint: "http://localhost:4000/feedback",
    showDeliverySettings: true,
    onSubmit(payload) {
      console.log(payload);
    }
  });
</script>
```

### Init options

- `projectId` (string) — payload に乗せるプロジェクト識別子
- `demoId` (string) — payload に乗せるデモ識別子
- `reviewer` (string, optional) — コメントフォームに初期表示する投稿者名。未指定の場合は保存済み reviewer を `localStorage` から復元し、保存値もなければ空欄
- `reviewerStorageKey` (string, optional) — reviewer 名を保存する `localStorage` key。デフォルトは `patchloop:reviewer`
- `persistFeedback` (boolean, optional) — feedback list を `localStorage` に保存し、同じ project / demo / page URL の reload 後に復元するか。デフォルトは `true`
- `feedbackStorageKey` (string, optional) — feedback list を保存する `localStorage` key。デフォルトは `patchloop:feedback`
- `deliveryMode` (`"receiver"` | `"slack-webhook"` | `"download"` | `"none"`, optional) — 送信方式。デフォルトは `"receiver"`
- `endpoint` (string, optional) — payload を `POST` する URL。未設定なら送信しない
- `slackWebhookUrl` (string, optional) — `deliveryMode: "slack-webhook"` 時にブラウザから直接送る Slack Incoming Webhook URL
- `showDeliverySettings` (boolean, optional) — drawer 内に送信先切替 UI を表示するか。デフォルトは `false`
- `captureScreenshot` (boolean, optional) — viewport snapshot を payload に含めるか。デフォルトは `true`
- `screenshotMaxBytes` (number, optional) — widget 側で snapshot を省略する最大バイト数。デフォルトは `1200000`
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
4. コメントと投稿者を書いて送信する。Cmd+Enter（Windows は Ctrl+Enter）でも送信できます。投稿者が空欄の場合は送信できません。コメントモードは送信後も継続するので、終了するには「コメントモード終了」を押します
5. drawer の一覧に追加され、`onSubmit(payload)` でも payload を受け取る。送信済みの項目は drawer 内から個別に編集・削除できる

投稿者名は送信後に `localStorage` へ保存され、次回以降の widget 起動時に復元されます。feedback list もデフォルトで `localStorage` に保存され、同じ project / demo / page URL の reload 後に drawer list と pin / area overlay が復元されます。drawer の「フィードバックを消す」は、表示中の marker と保存済み feedback の両方を削除します。永続化を使わず memory-only にしたい場合は `persistFeedback: false` を指定してください。

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
- `target.anchor` — アンカー要素 rect 内の相対位置（%）と `selector`。area の場合は `width` / `height` も含む。リサイズ・reload 時の要素への再アンカーに使用。area はドラッグ開始点ではなく範囲中心の要素にアンカーします。viewport より大きい要素（`main` / `body` 等）は相対位置が不安定なためアンカー対象にせず、その marker は従来座標（page px）固定 + 近似表示になります
- `environment.viewport`
- `environment.browser`
- `environment.language`
- `screenshot` — viewport snapshot。成功時は `status: "captured"`、`mimeType: "image/svg+xml"`、`dataUrl`、`targetOverlay` などを含む
- `createdAt`
- `delivery` — `endpoint` 設定時、POST 完了後に `{ ok, status }` または `{ ok: false, error }` が追加される

`target.kind` は `point` または `area` です。範囲選択の場合は `target.area` に viewport 上の percentage (`x` / `y` / `width` / `height`) に加えて、`clientX/Y/Width/Height`、`pageX/Y`、`documentX/Y/Width/Height` のピクセル値も入ります。

`clientX/clientY` は現在の viewport 上の位置、`pageX/pageY` はスクロールを含む document 上の位置です。pin / area overlay は document 上に固定されるため、スクロールしても対象箇所に追従します。ウィンドウリサイズでレイアウトが変わった場合は `target.selector` + `target.anchor` で対象要素に再アンカーされ、保存座標も再計算されます。

## ローカル receiver

`endpoint` を指定すると、widget は payload をその URL に POST します。検証用のローカル receiver が同梱されています。

```sh
node server/receive.js
```

- `POST /feedback` で payload を受け取り、デフォルトでは `server/feedback.json` に追記します
- `POST /import` で download mode の JSON bundle を読み込み、通常の inbox と同じ形式で保存します
- `GET /` で受信した feedback の一覧（inbox）を表示します
- inbox にはテキスト検索と status / kind / reviewer / source / Slack の絞り込みがあります
- 各 feedback には triage status（`new` / `accepted` / `fixed` / `ignored`）があり、card 上の select から変更できます。status は `server/feedback.json` に永続化されます
- `POST /feedback/:id/status` で API からも status を更新できます（body は `{"status": "accepted"}` 形式）
- GitHub 連携を設定すると、inbox の各 card から GitHub Issue を作成できます（後述）
- inbox UI から `.patchloop-feedback.json` を選択して import できます
- `GET /feedback.json` で raw JSON を返します
- `GET /screenshots/:file` で保存済み screenshot を返します
- `PORT` / `HOST` env で変更可能（デフォルトは `127.0.0.1:4000`）
- `FEEDBACK_STORE_PATH` env で保存先を変更できます
- `SCREENSHOT_DIR` env で screenshot 保存先を変更できます
- `PUBLIC_BASE_URL` env で Slack に載せる receiver の URL を指定できます
- `MAX_BODY_BYTES` / `SCREENSHOT_MAX_BYTES` env で payload / screenshot の上限を変更できます
- `SLACK_WEBHOOK_URL` env を設定すると、受信した feedback を Slack Incoming Webhook にも転送します
- `SLACK_IMAGE_MODE` env で Slack 上の screenshot 表示方式を変更できます（`auto` / `link` / `block` / `upload` / `off`）
- `SLACK_BOT_TOKEN` と `SLACK_UPLOAD_CHANNEL_ID` env を設定すると、保存済み screenshot を Slack file としてアップロードできます
- `SLACK_TIMEOUT_MS` env で Slack 転送の timeout を変更できます（デフォルトは `5000`）

`examples/plain-html/` はデフォルトで `http://localhost:4000/feedback` に送信する設定です。`python3 -m http.server 4173` でページを配信した状態で receiver も起動すると、コメントが inbox に届きます。

### Receiver 設定ファイル

Slack webhook URL などのローカル設定は `server/receiver.config.json` に置けます。このファイルは git 管理外です。共有用テンプレートとして `server/receiver.config.example.json` を用意しています。

```sh
cp server/receiver.config.example.json server/receiver.config.json
```

```json
{
  "host": "127.0.0.1",
  "port": 4000,
  "feedbackStorePath": "feedback.json",
  "screenshotDir": "screenshots",
  "publicBaseUrl": "http://127.0.0.1:4000",
  "maxBodyBytes": 3000000,
  "screenshotMaxBytes": 1500000,
  "slackWebhookUrl": "https://hooks.slack.com/services/...",
  "slackImageMode": "auto",
  "slackBotToken": "",
  "slackUploadChannelId": "",
  "slackTimeoutMs": 5000
}
```

`feedbackStorePath` / `screenshotDir` に相対パスを書く場合は、設定ファイルからの相対パスとして扱われます。`publicBaseUrl` は Slack 通知内の screenshot link と image block に使われます。ローカル検証なら `http://127.0.0.1:4000` のままで十分です。外部の Slack 上で画像 preview まで表示したい場合は、ngrok などで公開した URL を指定してください。

`slackImageMode` はデフォルト `auto` です。`publicBaseUrl` が公開 URL の場合は Slack message に image block を追加します。`slackBotToken` と `slackUploadChannelId` も設定されている場合は、Slack Web API で保存済み screenshot を file upload します。この token には Slack App の `files:write` scope が必要です。`link` はリンクのみ、`block` は image block を強制、`upload` は file upload のみ、`off` は screenshot 表示を送らない設定です。

別の場所の設定ファイルを使う場合は `PATCHLOOP_RECEIVER_CONFIG=/path/to/receiver.config.json node server/receive.js` で指定できます。

環境変数を指定した場合は設定ファイルより優先されます。たとえば一時的に Slack 転送を試す場合:

```sh
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." node server/receive.js
```

Slack 転送に失敗しても、receiver は payload を保存します。Slack の結果は保存済み payload の `integrations.slack` と inbox の `Slack` 行で確認できます。screenshot の `dataUrl` は receiver でファイル保存されたあと payload から取り除かれ、`screenshot.url` として参照されます。

### GitHub Issue 作成

inbox の feedback から GitHub Issue を作成できます。Issue 作成は receiver 側で行い、token がブラウザに渡ることはありません。

```sh
GITHUB_TOKEN="github_pat_..." GITHUB_REPO="owner/repo" node server/receive.js
```

- `GITHUB_TOKEN` / `githubToken` — GitHub token。**fine-grained PAT で対象リポジトリ + Issues: write のみに絞ることを推奨**
- `GITHUB_REPO` / `githubRepo` — Issue を作成するリポジトリ（`owner/repo` 形式）
- `GITHUB_LABELS` / `githubLabels` — 付与するラベル（env はカンマ区切り、config は配列）
- `GITHUB_ASSIGNEES` / `githubAssignees` — アサイン先（同上）
- `GITHUB_API_BASE` / `githubApiBase` — API base URL（デフォルト `https://api.github.com`。GHES やテスト時に変更）
- `GITHUB_TIMEOUT_MS` / `githubTimeoutMs` — timeout（デフォルト `8000`）

設定済みの場合、inbox の各 card に `Create GitHub Issue` ボタンが表示されます。作成された issue には feedback 本文・reviewer・ページ URL・selector・対象位置・viewport・screenshot link・raw payload が含まれます。結果は保存済み payload の `integrations.github` に永続化され、card には issue link（失敗時はエラー）が表示されます。同じ feedback からの二重作成は拒否されます。API から行う場合は `POST /feedback/:id/github-issue` を使います。

screenshot の画像は GitHub から `publicBaseUrl` に到達できる場合のみ issue 上に表示されます（ローカル receiver のままなら link のみ機能します）。

## Slack direct mode

`deliveryMode: "slack-webhook"` を使うと、receiver を立てずにブラウザから Slack Incoming Webhook に直接送信できます。drawer UI を有効にしている場合は、画面上で送信先を `Slack direct` に切り替えて webhook URL を入力できます。

```js
window.PatchLoop.init({
  deliveryMode: "slack-webhook",
  slackWebhookUrl: "https://hooks.slack.com/services/..."
});
```

このモードでは webhook URL がブラウザに見えるため、公開環境では使い捨ての検証用 webhook に限定してください。Incoming Webhook はブラウザ内で生成した `dataUrl` screenshot を Slack image/file として送れないため、Slack direct mode が Slack に送るのはコメント本文・ページ・対象位置・selector・viewport・screenshot 取得ステータスです。widget 内の payload と `onSubmit` には screenshot 情報が残ります。画像そのものを Slack に表示または file upload したい場合は、receiver mode で `publicBaseUrl` / `slackBotToken` / `slackUploadChannelId` を使ってください。ブラウザ直送は `no-cors` で投げるため、成功レスポンスの本文は取得できません。

## Download mode と receiver import

`deliveryMode: "download"` を使うと、receiver や Slack webhook を使わずに feedback をローカルファイルとして保存できます。

```js
window.PatchLoop.init({
  deliveryMode: "download",
  showDeliverySettings: true
});
```

送信時に `<project>-<demo>-<feedback-id>.patchloop-feedback.json` が保存されます。この bundle は単一 JSON ファイルで、現時点では ZIP ではありません。形式は versioned です。

```json
{
  "kind": "patchloop-feedback-bundle",
  "version": 1,
  "exportedAt": "2026-06-02T00:00:00.000Z",
  "projectId": "patchloop",
  "demoId": "plain-html-renewal-review",
  "feedback": {
    "id": "pl_...",
    "screenshot": {
      "status": "captured",
      "dataUrl": "data:image/svg+xml;base64,..."
    }
  }
}
```

Import するには receiver を起動し、inbox (`http://127.0.0.1:4000/`) の `Import feedback bundle` から `.patchloop-feedback.json` を選択します。API から送る場合は同じ JSON を `POST /import` に投げます。

```sh
curl -X POST http://127.0.0.1:4000/import \
  -H "Content-Type: application/json" \
  --data-binary @patchloop-feedback.json
```

receiver は bundle version と payload shape を検証し、screenshot の `dataUrl` を `server/screenshots/` に保存してから `server/feedback.json` に追記します。import した feedback には `source: "import"` / `importedAt` が付きます。Slack への再転送はせず、inbox 上では `Slack: skipped` と表示されます。

## 現在の境界

GitHub Issue 作成は receiver inbox からの手動操作のみで、自動作成や issue との双方向同期はありません。Slack は local receiver 経由の Incoming Webhook prototype として扱います。受信したフィードバックはローカル receiver に保存されます。widget 内の feedback list はブラウザの `localStorage` に保存できますが、チーム共有や長期保存用の永続 DB はまだありません。feedback を回収したい場合は `endpoint` 経由で receiver に送るか、download mode で bundle を保存してください。

未対応:

- Slack App / OAuth 連携
- 永続 DB
- pixel-perfect なブラウザ screenshot capture
- 認証
- AI PR 連携

## License

[MIT](./LICENSE)
