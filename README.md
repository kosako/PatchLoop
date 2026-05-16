# PatchLoop

PatchLoop is a local prototype for collecting browser-based visual feedback on AI-generated demos and turning that feedback into structured issue context.

## Run locally

Open `index.html` in a browser, or serve the folder with any static file server.

```sh
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

## What works now

- Demo portal with owner, expiry, data classification, and feedback counts
- Preview screen with feedback mode
- Click-to-comment pins on the preview
- Local feedback storage via `localStorage`
- Dashboard with status triage
- Generated GitHub Issue-style payload containing URL, position, selector, viewport, browser, branch, git SHA, logs, and AI instructions

## Current boundary

This first version does not call GitHub or store real screenshots on a backend. It creates local visual snapshots and mock Issue URLs so the product loop can be tested before adding auth, persistence, and integrations.
