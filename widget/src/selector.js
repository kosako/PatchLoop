// Selector generation for feedback targets. Operates on anything
// element-shaped (tagName / id / classList / parentElement / children), so
// node:test can exercise it with plain objects; the root element (document.body
// in the browser) is passed in by the caller.

export function cssEscape(value) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function selectorFor(element, rootElement) {
  if (!element || element === rootElement) return "body";
  if (element.id) return `#${cssEscape(element.id)}`;

  const parts = [];
  let current = element;
  while (current && current !== rootElement && parts.length < 4) {
    let part = current.tagName.toLowerCase();
    const classes = Array.from(current.classList || []).slice(0, 2);
    if (classes.length) part += `.${classes.map(cssEscape).join(".")}`;
    const parent = current.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

export function textFor(element) {
  return (element?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140);
}
