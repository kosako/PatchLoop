// The widget's stylesheet, which injectStyles in index.js puts in the page
// once (#170).
//
// The first three rules isolate the widget from the host page's CSS (#174).
// Page rules on bare element names, * and ::before / ::after (header,
// section, button, p, *::before, ...) would otherwise fill every property
// the widget leaves unset. Top-level widget nodes drop to initial values, so
// no page typography is inherited, except the lang-derived locale
// (-webkit-locale) that all: initial would also clear and that picks the
// Japanese glyphs. Their descendants and their ::before / ::after revert to
// the browser defaults.
// The reset is (0,1,0) ((0,1,1) for pseudo-elements) and comes first, so
// every widget rule below must start with a .pl- class or a data-patchloop
// attribute to win over it. The descendant reset is kept apart from the
// :is() rule so that a browser without :is() still applies it.
// Not covered: page rules of (0,1,1) or more (button:hover, textarea:focus,
// section > header:first-child), !important, (0,1,0) attribute rules loaded
// after init, other pseudo-elements (::placeholder, ::marker, ::selection),
// and direction / unicode-bidi, which all does not reset. Full isolation
// would need a shadow root.
// The colors used across the widget are custom properties (#170), named as
// the inbox's CSS names them (ink, muted, line, accent, danger) but with the
// widget's own values, set on its top-level nodes. --pl-danger also marks
// the capture mode and areas. all: does not reset custom properties, so the
// descendant and pseudo-element resets set each of them to inherit: a page
// rule on a bare element name (button { --pl-accent: ... }) would otherwise
// set it on a widget node itself, ahead of the value the node inherits.
// What the reset does not cover (above) is not covered for them either.
// A dot-only marker (#147) draws its dot as a bordered ::before box rather
// than a background gradient: forced colors mode drops gradients but keeps
// borders, in the user's colors, so the dot stays visible there.
export const WIDGET_CSS = `
    .pl-root, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection] { all: initial; -webkit-locale: inherit; }
    .pl-root *, [data-patchloop-area] * { all: revert; --pl-ink: inherit; --pl-muted: inherit; --pl-line: inherit; --pl-accent: inherit; --pl-danger: inherit; }
    :is(.pl-root, .pl-root *, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-area] *, [data-patchloop-selection])::before, :is(.pl-root, .pl-root *, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-area] *, [data-patchloop-selection])::after { all: revert; --pl-ink: inherit; --pl-muted: inherit; --pl-line: inherit; --pl-accent: inherit; --pl-danger: inherit; }
    .pl-root, [data-patchloop-pin], [data-patchloop-area], [data-patchloop-selection] { --pl-ink: #14211d; --pl-muted: #65716d; --pl-line: #d9e1dd; --pl-accent: #0f7b63; --pl-danger: #b83d4d; }
    .pl-root, .pl-root * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: normal; }
    .pl-root [hidden], .pl-comment[hidden], .pl-tooltip[hidden], [data-patchloop-pin][hidden], [data-patchloop-area][hidden] { display: none !important; }
    .pl-root { position: fixed; z-index: 2147483000; color: var(--pl-ink); right: 20px; bottom: max(20px, env(safe-area-inset-bottom)); font-size: 14px; line-height: 1.5; text-align: left; }
    .pl-panel { position: absolute; right: 0; bottom: 0; width: min(400px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); background: #fff; border: 1px solid var(--pl-line); border-radius: 16px; box-shadow: 0 18px 65px rgba(20, 33, 29, 0.16); overflow: auto; overscroll-behavior: contain; }
    .pl-panel header { min-height: 64px; padding: 12px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #edf1ee; }
    .pl-title { flex: 1; min-width: 0; font-size: 17px; font-weight: 750; order: -1; }
    .pl-handle { min-width: 42px; min-height: 36px; padding: 6px 10px; border: 0; background: #f2f6f3; cursor: pointer; font-size: 11px; color: #42584c; border-radius: 8px; font-weight: 600; }
    .pl-handle:hover { background: #f0f3ef; }
    .pl-handle.pl-mode-on { background: var(--pl-danger); color: #fff; }
    .pl-handle.pl-mode-on:hover { background: #9f3442; }
    .pl-mode { display: block; width: 100%; min-height: 44px; padding: 10px 16px; border-radius: 9px; border: 1px solid var(--pl-accent); background: var(--pl-accent); color: #fff; font-weight: 650; font-size: 13px; cursor: pointer; }
    .pl-mode[aria-pressed="true"] { background: var(--pl-danger); border-color: var(--pl-danger); }
    .pl-panel.pl-collapsed { width: auto; min-width: 152px; border-radius: 999px; overflow: hidden; background: var(--pl-accent); border-color: var(--pl-accent); }
    .pl-feedback-active .pl-panel.pl-collapsed { background: var(--pl-danger); border-color: var(--pl-danger); }
    .pl-panel.pl-collapsed header { padding: 0; min-height: 48px; border-bottom: 0; gap: 0; }
    .pl-panel.pl-collapsed .pl-title,
    .pl-panel.pl-collapsed .pl-mode { display: none; }
    .pl-panel.pl-collapsed .pl-panel-body { display: none; }
    .pl-panel p { margin: 0; color: var(--pl-muted); font-size: 12px; line-height: 1.7; }
    .pl-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 20px 18px; }
    .pl-actions button, .pl-form-actions button { min-height: 40px; border-radius: 8px; border: 1px solid var(--pl-line); background: #fff; color: var(--pl-ink); padding: 8px 12px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .pl-actions [data-pl-download-all] { background: var(--pl-accent); border-color: var(--pl-accent); color: #fff; font-weight: 800; }
    .pl-actions [data-pl-download-all]:disabled { background: #cfd8d4; border-color: #cfd8d4; color: #fff; cursor: default; }
    .pl-form-actions button[type="submit"] { background: var(--pl-accent); border-color: var(--pl-accent); color: #fff; font-weight: 800; }
    .pl-delivery-settings { margin: 0 20px 20px; border-top: 1px solid var(--pl-line); padding-top: 14px; background: #fff; }
    .pl-delivery-settings summary { cursor: pointer; color: var(--pl-muted); font-weight: 600; font-size: 12px; }
    .pl-delivery-settings label { display: grid; gap: 5px; margin-top: 8px; color: var(--pl-muted); font-size: 11px; font-weight: 800; }
    .pl-delivery-settings input, .pl-delivery-settings select { width: 100%; min-height: 40px; border: 1px solid var(--pl-line); border-radius: 7px; background: #fff; color: var(--pl-ink); padding: 8px 10px; font: inherit; font-size: 12px; }
    .pl-feedback-list { max-height: min(320px, 40dvh); overflow-y: auto; padding: 0 20px 18px; display: grid; gap: 10px; overscroll-behavior: contain; }
    .pl-feedback-list-empty { margin: 0; color: var(--pl-muted); font-size: 12px; padding: 24px 12px !important; border: 1px dashed var(--pl-line); border-radius: 9px; text-align: center; }
    .pl-feedback-item { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 8px 10px; padding: 14px; border: 1px solid #e2e9e5; border-radius: 10px; background: #fff; align-items: start; }
    .pl-feedback-num { width: 24px; height: 24px; min-width: 24px; min-height: 24px; box-sizing: border-box; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 900; font-size: 11px; line-height: 1; }
    .pl-feedback-num.kind-point { background: var(--pl-accent); }
    .pl-feedback-num.kind-area { background: var(--pl-danger); }
    .pl-feedback-body { display: grid; gap: 4px; min-width: 0; }
    .pl-feedback-meta { color: var(--pl-muted); font-weight: 500; font-size: 10px; }
    .pl-feedback-text { color: var(--pl-ink); font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
    .pl-feedback-actions { display: flex; gap: 8px; grid-column: 2; margin-top: 4px; }
    .pl-feedback-actions button { min-height: 32px; padding: 4px 10px; font-size: 11px; border-radius: 6px; border: 1px solid var(--pl-line); background: #fff; color: var(--pl-ink); cursor: pointer; font-weight: 500; }
    .pl-feedback-actions [data-pl-delete] { border-color: var(--pl-danger); color: var(--pl-danger); }
    .pl-feedback-status-ok { color: var(--pl-accent); }
    .pl-feedback-status-fail { color: var(--pl-danger); }
    .pl-feedback-status-unknown { color: var(--pl-muted); }
    .pl-feedback-exported { color: var(--pl-accent); font-weight: 900; font-size: 10px; border: 1px solid var(--pl-accent); border-radius: 999px; padding: 1px 6px; margin-left: 2px; }
    .pl-feedback-item-exported { background: #f7f8f5; }
    .pl-tooltip { position: fixed; max-width: 280px; background: var(--pl-ink); color: #fff; padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; pointer-events: none; z-index: 2147483002; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.32); white-space: pre-wrap; word-break: break-word; }
    .pl-comment { position: fixed; z-index: 2147483001; width: min(360px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow-y: auto; overscroll-behavior: contain; display: grid; gap: 14px; padding: 22px; background: #fff; border: 1px solid var(--pl-line); border-radius: 14px; box-shadow: 0 18px 70px rgba(20, 33, 29, 0.22); }
    .pl-comment label { display: grid; gap: 6px; color: #42584c; font-size: 12px; font-weight: 600; }
    .pl-comment textarea, .pl-comment input { width: 100%; border: 1px solid #ccd9d1; border-radius: 8px; padding: 10px 12px; background: #fff; color: var(--pl-ink); font: inherit; font-size: 14px; line-height: 1.6; resize: vertical; }
    .pl-comment .pl-field { display: grid; gap: 6px; }
    .pl-comment .pl-field-count { justify-self: end; color: var(--pl-danger); font-size: 12px; font-weight: 600; }
    .pl-form-error { margin: 0; padding: 10px 12px; border-radius: 6px; color: var(--pl-danger); background: #fff0f2; font-size: 12px; font-weight: 600; }
    .pl-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .pl-pin { position: absolute; z-index: 2147482999; transform: translate(-50%, -50%); width: 30px; height: 30px; min-width: 30px; min-height: 30px; max-width: 30px; max-height: 30px; box-sizing: border-box; display: grid; place-items: center; padding: 0; line-height: 1; border-radius: 50%; border: 3px solid #fff; background: var(--pl-danger); color: #fff; font: 900 13px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); cursor: pointer; }
    .pl-selection { position: fixed; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; }
    .pl-area { position: absolute; z-index: 2147482998; border: 2px solid #d1495b; background: rgba(209, 73, 91, 0.12); border-radius: 6px; pointer-events: none; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.16); }
    .pl-area button { position: absolute; top: 6px; left: 6px; width: 30px; height: 30px; min-width: 30px; min-height: 30px; padding: 0; box-sizing: border-box; display: grid; place-items: center; border-radius: 50%; border: 3px solid #fff; background: var(--pl-danger); color: #fff; font: 900 13px/1 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); pointer-events: auto; cursor: pointer; }
    .pl-pin.pl-marker-dot, .pl-area.pl-marker-dot button { width: 24px; height: 24px; min-width: 24px; min-height: 24px; max-width: 24px; max-height: 24px; border: 0; background: transparent; box-shadow: none; font-size: 0; }
    .pl-pin.pl-marker-dot::before, .pl-area.pl-marker-dot button::before { content: ""; width: 13px; height: 13px; box-sizing: border-box; border: 1.5px solid #fff; border-radius: 50%; background: var(--pl-danger); }
    .pl-area.pl-marker-dot button { top: 9px; left: 9px; }
    .pl-pin.pl-marker-done, .pl-area.pl-marker-done button { background: #6b7570; border-style: dashed; }
    .pl-area.pl-marker-done { border-color: #6b7570; border-style: dashed; background: rgba(107, 117, 112, 0.10); }
    .pl-area.pl-marker-dot:not(:hover):not(:focus-within) { border-color: transparent; background: transparent; box-shadow: none; outline: none !important; }
    .pl-feedback-active [data-patchloop-pin], .pl-feedback-active .pl-area button { pointer-events: none; }
    .pl-target-highlight { outline: 2px dashed #d1495b; outline-offset: 2px; }
    .pl-marker-approx { outline: 3px dashed #f2a33c !important; outline-offset: 2px; }
    [data-patchloop-pin].pl-marker-clipped, [data-patchloop-area].pl-marker-clipped { display: none !important; }
    [data-patchloop-area].pl-marker-cut { overflow: hidden !important; }
    .pl-feedback-approx { color: #986000; font-weight: 900; cursor: help; margin-left: 2px; }
    .pl-feedback-active, .pl-feedback-active * { cursor: crosshair !important; }
    .pl-root :focus-visible, .pl-pin:focus-visible, .pl-area button:focus-visible { outline: 3px solid #168565; outline-offset: 3px; }
    .pl-capture-guide { position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: space-between; gap: 16px; width: max-content; max-width: calc(100vw - 24px); padding: 12px 16px; background: var(--pl-ink); color: #fff; border-radius: 12px; box-shadow: 0 10px 40px #14211d33; font-size: 12px; }
    .pl-capture-guide small { display: block; font-size: 10px; color: #d1dfd7; margin-top: 3px; }
    .pl-capture-guide button { border: 1px solid var(--pl-muted); border-radius: 7px; background: #fff; color: var(--pl-ink); min-height: 36px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
    .pl-feedback-active [data-patchloop-root], .pl-feedback-active [data-patchloop-root] * { cursor: auto !important; }
    .pl-root button:disabled { cursor: wait; opacity: .55; }
    .pl-panel.pl-collapsed .pl-handle { flex: 1; padding: 12px 14px 12px 22px; min-height: 48px; border-radius: 0; color: #fff; background: var(--pl-accent); font-size: 13px; white-space: nowrap; }
    .pl-panel.pl-collapsed .pl-handle.pl-mode-on { background: var(--pl-danger); }
    .pl-tuck { display: none; }
    .pl-panel.pl-collapsed .pl-tuck { display: grid; place-items: center; width: 36px; min-width: 36px; min-height: 48px; padding: 0 6px 0 0; border: 0; border-left: 1px solid #3f9582; background: var(--pl-accent); color: #fff; font-size: 18px; font-weight: 700; line-height: 1; cursor: pointer; }
    .pl-panel.pl-collapsed .pl-tuck.pl-mode-on { background: var(--pl-danger); border-left-color: #cd6f7b; }
    .pl-tab { position: fixed; right: 0; bottom: max(20px, env(safe-area-inset-bottom)); display: grid; place-items: center; width: 36px; min-height: 48px; padding: 0; border: 0; border-radius: 10px 0 0 10px; background: var(--pl-accent); color: #fff; font-size: 18px; font-weight: 700; line-height: 1; cursor: pointer; box-shadow: 0 12px 30px rgba(20, 33, 29, 0.25); }
    .pl-tab.pl-mode-on { background: var(--pl-danger); }
    .pl-panel-body { padding-top: 18px; }
    .pl-compose { padding: 0 20px 18px; }
    .pl-compose p { padding: 10px 0 0; font-size: 11px; }
    .pl-list-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 0 20px 10px; font-size: 11px; color: #53695d; }
    .pl-list-heading span { border-radius: 5px; padding: 1px 7px; background: #edf4ef; font-variant-numeric: tabular-nums; }
    .pl-display-mode { margin: 0 20px 12px; padding: 0; border: 0; min-width: 0; }
    .pl-display-mode legend { padding: 0 0 4px; font-size: 11px; font-weight: 600; color: #53695d; }
    .pl-display-mode label { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin-right: 16px; color: var(--pl-ink); font-size: 12px; cursor: pointer; }
    .pl-display-mode input { width: 16px; height: 16px; margin: 0; accent-color: var(--pl-accent); cursor: pointer; }
    .pl-feedback-item:focus { outline: 3px solid #168565; outline-offset: -3px; }
    .pl-actions [data-pl-clear] { border: 0; color: var(--pl-muted); font-size: 10px; padding: 5px 0; min-height: 32px; }
    .pl-actions [data-pl-download-again] { font-size: 11px; }
    .pl-panel .pl-other-pages { margin: -8px 20px 16px; color: #7a5200; font-size: 11px; line-height: 1.5; }
    .pl-panel .pl-notice { margin: 0 20px 16px; padding: 10px 12px; border-radius: 8px; background: #edf6ef; color: #245840; font-size: 11px; }
    .pl-panel .pl-notice[data-state="error"] { background: #fff0f2; color: #a32f45; }
    .pl-form-heading { display: grid; gap: 4px; }
    .pl-form-heading strong { font-size: 16px; font-weight: 700; }
    .pl-form-heading span { color: var(--pl-muted); font-size: 11px; }
    .pl-comment .pl-screenshot-option { display: flex; align-items: center; gap: 8px; font-weight: 500; }
    .pl-comment input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--pl-accent); }
    .pl-comment .pl-capture-note, .pl-comment .pl-edit-note { margin: -5px 0 0; font-size: 10px; line-height: 1.6; color: var(--pl-muted); }
    .pl-comment .pl-edit-note { padding: 10px; background: #fff8e7; color: #785011; border-radius: 6px; }
    .pl-comment .pl-uncaptured-hint { margin: -5px 0 0; padding: 10px; background: #fff8e7; color: #785011; border-radius: 6px; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
    .pl-keyboard-hint { color: var(--pl-muted); font-size: 10px; text-align: right; }
    .pl-feedback-status { display: inline-block; margin-left: 5px; font-weight: 600; }
    .pl-inbox-status { display: inline-block; margin-left: 5px; padding: 0 6px; border: 1px solid var(--pl-line); border-radius: 999px; color: #42584c; font-weight: 600; }
    .pl-inbox-status-done { border-color: var(--pl-accent); color: var(--pl-accent); }
    .pl-inbox-status-missing { border-color: #e2c48a; color: #785011; }
    @media (max-width: 480px) {
      .pl-root { right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); }
      .pl-tab { bottom: max(12px, env(safe-area-inset-bottom)); }
      .pl-panel { width: calc(100vw - 24px); }
      .pl-comment { padding: 18px; }
      .pl-comment textarea, .pl-comment input { font-size: 16px; }
      .pl-feedback-list { max-height: 28dvh; }
    }
    @media (prefers-reduced-motion: reduce) { .pl-root *, .pl-pin, .pl-area { transition: none !important; scroll-behavior: auto !important; } }

  `;
