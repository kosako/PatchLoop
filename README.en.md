# PatchLoop

> 日本語版: [README.md](./README.md)

PatchLoop is an experimental prototype for collecting browser-based visual feedback on AI-generated demos and turning that feedback into Slack, GitHub, or AI repair context.

## Run Locally

Serve the folder with any static file server and open `examples/plain-html/`.

```sh
python3 -m http.server 4173
```

```text
http://localhost:4173/examples/plain-html/
```

## Development

Install dependencies.

```sh
npm install
```

Run lint and tests.

```sh
npm run lint
npm test
npm run check
```

`npm test` uses the Node.js test runner to start the local receiver on a temporary port and verify `/feedback` and `/import` storage, validation, and screenshot handling. Test data is created under the OS temp directory and removed after each test.

## What Works Now

script-tag widget:

- Right-edge drawer with collapse handle that stays out of the way
- Comment mode toggle in the drawer header (active state colours the handle)
- Click-to-pin location capture and drag-to-select area capture
- Draft markers that take their final sequential number on submit
- Comment mode stays active after submit so several spots can be annotated in a row
- Cmd+Enter (Ctrl+Enter on Windows) submits the comment form
- Target element outline while a draft is pending
- Per-feedback comment list with reviewer, kind, comment, and delivery status
- Hover tooltip on markers showing the comment (disabled in feedback mode)
- Per-item edit and delete inside the drawer with marker renumbering
- Payload with URL, point/area position, selector, viewport, browser, reviewer, and timestamp
- Lightweight viewport screenshot snapshot (SVG) attached to each payload
- `localStorage` persistence for the feedback list, including pin / area overlay restoration after reload
- Optional `onSubmit(payload)` callback
- Optional `endpoint` setting that POSTs payloads to the bundled local receiver
- Optional Slack Incoming Webhook forwarding from the local receiver with screenshot links, image blocks, and optional file upload
- Download mode that saves a versioned JSON bundle for each feedback item
- Receiver inbox import for bundles created by download mode
- Configurable delivery mode for receiver forwarding, direct Slack webhook delivery, download, or no delivery

## Embeddable Widget

PatchLoop includes a standalone widget that can be embedded into a normal HTML page with a `script` tag.

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

- `projectId` (string) — identifier carried in the payload
- `demoId` (string) — identifier carried in the payload
- `reviewer` (string, optional) — pre-fills the reviewer field in the comment form. When omitted, the widget restores a saved reviewer from `localStorage`; otherwise the field starts empty
- `reviewerStorageKey` (string, optional) — `localStorage` key used to persist the reviewer name; defaults to `patchloop:reviewer`
- `persistFeedback` (boolean, optional) — save the feedback list to `localStorage` and restore it after reloads on the same project / demo / page URL; defaults to `true`
- `feedbackStorageKey` (string, optional) — `localStorage` key used to persist the feedback list; defaults to `patchloop:feedback`
- `deliveryMode` (`"receiver"` | `"slack-webhook"` | `"download"` | `"none"`, optional) — delivery target; defaults to `"receiver"`
- `endpoint` (string, optional) — URL the widget POSTs each payload to; nothing is sent when omitted
- `slackWebhookUrl` (string, optional) — Slack Incoming Webhook URL used when `deliveryMode: "slack-webhook"`
- `showDeliverySettings` (boolean, optional) — show the delivery target controls in the drawer; defaults to `false`
- `captureScreenshot` (boolean, optional) — include a viewport snapshot in the payload; defaults to `true`
- `screenshotMaxBytes` (number, optional) — widget-side byte limit before omitting the snapshot; defaults to `1200000`
- `onSubmit(payload)` (function, optional) — called on every submit

### window.PatchLoop API

- `PatchLoop.init(options)` — mount the widget and start capturing
- `PatchLoop.destroy()` — remove the widget DOM, markers, and highlights
- `PatchLoop.setFeedbackMode(boolean)` — toggle comment mode programmatically
- `PatchLoop.getFeedback()` — return a copy of the current feedback list (newest first)

### Events

`document` dispatches `patchloop:feedback` with `event.detail = payload` whenever a comment is submitted, before any `endpoint` POST resolves.

### Basic flow

1. Click the right-edge handle to open the drawer
2. Start comment mode
3. Click a point or drag an area on the page
4. Write a comment and reviewer name, then submit (Cmd+Enter / Ctrl+Enter also works). Feedback cannot be submitted while the reviewer is blank. Comment mode stays active after submit; end it with the mode button in the drawer header
5. The comment appears in the drawer list and is also passed to `onSubmit(payload)`. Each item can be edited or deleted from the list

The reviewer name is saved to `localStorage` after submit and restored the next time the widget starts. The feedback list is also saved to `localStorage` by default and restored after reloads on the same project / demo / page URL, including pins and area overlays. The drawer's clear action removes both visible markers and saved feedback. Set `persistFeedback: false` for memory-only behavior.

## Payload

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
- `screenshot` — viewport snapshot. On success it includes `status: "captured"`, `mimeType: "image/svg+xml"`, `dataUrl`, `targetOverlay`, and related metadata
- `createdAt`
- `delivery` — added after the POST resolves when `endpoint` is set (`{ ok, status }` or `{ ok: false, error }`)

`target.kind` is either `point` or `area`. For area selections, `target.area` carries the viewport percentages (`x` / `y` / `width` / `height`) plus pixel values for `clientX/Y/Width/Height`, `pageX/Y`, and `documentX/Y/Width/Height`.

`clientX/clientY` represent viewport coordinates, while `pageX/pageY` represent document coordinates including scroll. Pins and area overlays are anchored to document coordinates so they stay attached to the target while scrolling.

## Local Receiver

When `endpoint` is set, the widget POSTs the payload to that URL. A local receiver is bundled for testing.

```sh
node server/receive.js
```

- Accepts payload at `POST /feedback`, appending to `server/feedback.json` by default
- Imports download-mode JSON bundles at `POST /import`, storing them in the same inbox format
- Renders an inbox of received feedback at `GET /`
- Imports `.patchloop-feedback.json` files from the inbox UI
- Returns the raw JSON at `GET /feedback.json`
- Serves saved screenshots from `GET /screenshots/:file`
- Configurable via `PORT` / `HOST` env (default `127.0.0.1:4000`)
- Configurable storage path via `FEEDBACK_STORE_PATH`
- Configurable screenshot directory via `SCREENSHOT_DIR`
- Configurable receiver URL for Slack links via `PUBLIC_BASE_URL`
- Configurable payload and screenshot limits via `MAX_BODY_BYTES` / `SCREENSHOT_MAX_BYTES`
- Forwards received feedback to a Slack Incoming Webhook when `SLACK_WEBHOOK_URL` is set
- Configurable Slack screenshot presentation via `SLACK_IMAGE_MODE` (`auto` / `link` / `block` / `upload` / `off`)
- Optional Slack file upload via `SLACK_BOT_TOKEN` and `SLACK_UPLOAD_CHANNEL_ID`
- Configurable Slack forwarding timeout via `SLACK_TIMEOUT_MS` (default `5000`)

`examples/plain-html/` is preconfigured to send to `http://localhost:4000/feedback`. Serve the page with `python3 -m http.server 4173`, start the receiver alongside it, and submitted comments will appear in the inbox.

### Receiver Config File

Local settings such as the Slack webhook URL can live in `server/receiver.config.json`. This file is ignored by git. A shareable template is available at `server/receiver.config.example.json`.

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

Relative `feedbackStorePath` and `screenshotDir` values are resolved from the config file location. `publicBaseUrl` is used for screenshot links and image blocks in Slack messages. For local testing, `http://127.0.0.1:4000` is enough. If you want Slack image previews to render outside your machine, point it at a public tunnel such as ngrok.

`slackImageMode` defaults to `auto`. When `publicBaseUrl` is public, the receiver adds a Slack image block. When `slackBotToken` and `slackUploadChannelId` are also set, the receiver uploads the saved screenshot as a Slack file through the Slack Web API. The token needs the Slack App `files:write` scope. Use `link` for links only, `block` to force an image block, `upload` for file upload only, or `off` to omit screenshot presentation.

To use a config file from another path, run `PATCHLOOP_RECEIVER_CONFIG=/path/to/receiver.config.json node server/receive.js`.

Environment variables override the config file. For example, to try Slack forwarding temporarily:

```sh
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." node server/receive.js
```

If Slack forwarding fails, the receiver still stores the payload. The Slack result is visible in the saved payload under `integrations.slack` and in the inbox `Slack` row. Screenshot `dataUrl` values are saved as files by the receiver and replaced with `screenshot.url` in stored payloads.

## Slack Direct Mode

Use `deliveryMode: "slack-webhook"` to send directly from the browser to a Slack Incoming Webhook without running the receiver. When the drawer delivery settings are enabled, you can switch the target to `Slack direct` and enter the webhook URL in the UI.

```js
window.PatchLoop.init({
  deliveryMode: "slack-webhook",
  slackWebhookUrl: "https://hooks.slack.com/services/..."
});
```

This exposes the webhook URL in the browser, so keep it to disposable testing webhooks in public environments. Incoming Webhooks cannot send a browser-generated `dataUrl` screenshot as a Slack image or file, so Slack direct mode sends the comment, page, target position, selector, viewport, and screenshot capture status. The screenshot data still remains available in the widget payload and `onSubmit`. To show or upload the generated screenshot in Slack, use receiver mode with `publicBaseUrl` or Slack file upload settings. Direct browser delivery uses `no-cors`, so the response body is not available to the widget.

## Download Mode And Receiver Import

Use `deliveryMode: "download"` to save feedback as a local file without running the receiver or using a Slack webhook.

```js
window.PatchLoop.init({
  deliveryMode: "download",
  showDeliverySettings: true
});
```

On submit, the widget downloads `<project>-<demo>-<feedback-id>.patchloop-feedback.json`. The bundle is a single JSON file for now, not a ZIP. The format is versioned.

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

To import a bundle, start the receiver and open the inbox (`http://127.0.0.1:4000/`), then choose the `.patchloop-feedback.json` file under `Import feedback bundle`. To import through the API, post the same JSON to `POST /import`.

```sh
curl -X POST http://127.0.0.1:4000/import \
  -H "Content-Type: application/json" \
  --data-binary @patchloop-feedback.json
```

The receiver validates the bundle version and payload shape, saves the screenshot `dataUrl` to `server/screenshots/`, and appends the imported feedback to `server/feedback.json`. Imported feedback gets `source: "import"` and `importedAt`. The receiver does not forward imported feedback to Slack; the inbox shows `Slack: skipped`.

## Current Boundary

This version does not send to GitHub directly yet. Slack support is currently a local-receiver Incoming Webhook prototype. Received feedback is stored by the local receiver. The widget feedback list can be persisted in browser `localStorage`, but there is still no shared long-term database. Use a receiver `endpoint` or download mode when you need to collect feedback outside the current browser.

Not included yet:

- Slack App / OAuth integration
- GitHub Issue creation
- Persistent database
- Pixel-perfect browser screenshot capture
- Auth
- AI PR integration

## License

[MIT](./LICENSE)
