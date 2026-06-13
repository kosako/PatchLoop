// CSS processing for the SVG snapshot. Media conditions are injected as a
// `mediaMatches(mediaText) => boolean` callback (window.matchMedia in the
// browser) so node:test can exercise the flattening with plain objects.

// Viewport units re-resolve against the rendered size just like media
// queries do, so freeze them to the captured viewport in pixels.
//
// The lookbehind keeps the replacement to declaration values: a match is
// rejected when it is glued to a preceding word/url character, which is what
// base64 data URIs (`...A9vw/`, `+5vh=`), escaped selectors (`.h-\[100vh\]`),
// and custom property names (`--col-50vw`) all look like. Real CSS values are
// preceded by a space, `(`, `,` or `:`; even calc() requires whitespace
// around `+`/`-`, so a glued sign cannot be a real value either.
const VIEWPORT_UNIT_RE = /(?<![\w.%#/\\[+-])(-?\d*\.?\d+)(?:[dsl])?v(w|h|min|max)\b/g;

export function freezeViewportUnits(cssText, width, height) {
  return cssText.replace(VIEWPORT_UNIT_RE, (match, number, axis) => {
    const value = Number(number);
    if (!Number.isFinite(value)) return match;
    const base = axis === "w"
      ? width
      : axis === "h"
        ? height
        : axis === "min" ? Math.min(width, height) : Math.max(width, height);
    return `${(value * base) / 100}px`;
  });
}

export function flattenRulesForSnapshot(rules, mediaMatches) {
  return Array.from(rules || [])
    .map((rule) => {
      if (rule.styleSheet) {
        // @import: inline the imported sheet, honoring its media list.
        const media = rule.media && rule.media.mediaText;
        if (media && !mediaMatches(media)) return "";
        try {
          return flattenRulesForSnapshot(rule.styleSheet.cssRules, mediaMatches);
        } catch (_) {
          return "";
        }
      }
      if (rule.media) {
        return mediaMatches(rule.media.mediaText)
          ? flattenRulesForSnapshot(rule.cssRules, mediaMatches)
          : "";
      }
      if (rule.cssRules && rule.cssRules.length) {
        // Grouping rules (@supports, @layer, @container, @keyframes, …):
        // keep the wrapper but flatten the children, so an @media nested
        // inside resolves at capture time instead of re-evaluating against
        // the SVG's rendered size. @container still re-evaluates against
        // the rendered container (issue #51 leftover) — resolving it would
        // need per-element layout queries.
        const inner = flattenRulesForSnapshot(rule.cssRules, mediaMatches);
        if (!inner) return "";
        const cssText = rule.cssText || "";
        const braceIndex = cssText.indexOf("{");
        if (braceIndex === -1) return cssText;
        return `${cssText.slice(0, braceIndex).trim()} {\n${inner}\n}`;
      }
      return rule.cssText;
    })
    .filter(Boolean)
    .join("\n");
}
