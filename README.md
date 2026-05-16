# PatchLoop

PatchLoop is a local prototype for collecting browser-based visual feedback on AI-generated demos and turning that feedback into structured issue context.

## Run locally

Open `index.html` in a browser, or serve the folder with any static file server.

```sh
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

The embeddable widget example is available at:

```text
http://localhost:4173/examples/plain-html/
```

## What works now

- Demo portal with owner, expiry, data classification, and feedback counts
- Preview screen with feedback mode
- Click-to-comment pins on the preview
- Local feedback storage via `localStorage`
- Dashboard with status triage
- Generated GitHub Issue-style payload containing URL, position, selector, viewport, browser, branch, git SHA, logs, and AI instructions

## Embeddable widget

PatchLoop now includes a standalone script-tag widget:

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

The first widget slice supports:

- Floating feedback launcher
- Comment mode toggle
- Click-to-pin location capture
- Comment form
- Payload generation with URL, x/y position, selector, viewport, browser, reviewer, and timestamp
- Optional `onSubmit(payload)` callback
- Optional `endpoint` setting for a future POST receiver

## Current boundary

This version does not call GitHub, Slack, or a backend. It creates local visual snapshots and feedback payloads so the product loop can be tested before adding delivery adapters, auth, persistence, and integrations.
