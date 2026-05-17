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

## What Works Now

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

## Embeddable Widget

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

- `projectId` (string) — identifier carried in the payload
- `demoId` (string) — identifier carried in the payload
- `reviewer` (string, optional) — pre-fills the reviewer field in the comment form
- `endpoint` (string, optional) — URL the widget POSTs each payload to; nothing is sent when omitted
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
4. Write a comment and reviewer name, then submit
5. The comment appears in the drawer list and is also passed to `onSubmit(payload)`. Each item can be edited or deleted from the list

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
- `createdAt`
- `delivery` — added after the POST resolves when `endpoint` is set (`{ ok, status }` or `{ ok: false, error }`)

`target.kind` is either `point` or `area`. For area selections, `target.area` carries the viewport percentages (`x` / `y` / `width` / `height`) plus pixel values for `clientX/Y/Width/Height`, `pageX/Y`, and `documentX/Y/Width/Height`.

`clientX/clientY` represent viewport coordinates, while `pageX/pageY` represent document coordinates including scroll. Pins and area overlays are anchored to document coordinates so they stay attached to the target while scrolling.

## Local Receiver

When `endpoint` is set, the widget POSTs the payload to that URL. A local receiver is bundled for testing.

```sh
node server/receive.js
```

- Accepts payload at `POST /feedback`, appends to `server/feedback.json`
- Renders an inbox of received feedback at `GET /`
- Returns the raw JSON at `GET /feedback.json`
- Configurable via `PORT` / `HOST` env (default `127.0.0.1:4000`)

`examples/plain-html/` is preconfigured to send to `http://localhost:4000/feedback`. Serve the page with `python3 -m http.server 4173`, start the receiver alongside it, and submitted comments will appear in the inbox.

## Current Boundary

This version does not send to GitHub or Slack directly yet. Received feedback is stored in `server/feedback.json` by the local receiver. The drawer list inside the widget is kept in memory only and is cleared on reload — wire up `endpoint` if you need persistence.

Not included yet:

- Slack delivery
- GitHub Issue creation
- Persistent database
- Real screenshot capture
- Auth
- AI PR integration
