"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createInboxView } = require("../server/inbox-view.js");

const script = fs.readFileSync(path.join(__dirname, "../server/static/inbox.js"), "utf8");

// The page inbox.js runs against is parsed from renderInbox() output, so the
// hooks the tests reach (data-* attributes, hidden, the rendered options of
// each select, the markup inside a card) are exactly the ones the server
// sends. As in widget-dom.js the parser is strict: markup it cannot read,
// mismatched or unclosed tags, and selectors it cannot evaluate throw instead
// of silently matching nothing.
const VOID_TAGS = new Set(["br", "hr", "img", "input", "link", "meta"]);
// Like a browser, these properties are their attribute, so selectors,
// outerHTML and the script agree whichever side changed them.
const REFLECTED_BOOLEANS = ["disabled", "hidden"];
const REFLECTED_STRINGS = ["href", "id", "rel", "target"];
const FORM_CONTROLS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const TOKEN = /<!doctype[^>]*>|<!--[\s\S]*?-->|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>|([^<]+)|([\s\S])/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;
const SELECTOR = /^([a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i;
const SELECTOR_PART = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;

const decodeEntities = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
  if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
  return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
});
const dataAttribute = (key) => "data-" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
const escapeText = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

function matchesSelector(node, selector) {
  return selector.split(",").some((alternative) => {
    const simple = alternative.trim();
    const match = simple && SELECTOR.exec(simple);
    if (!match) throw new Error(`inbox-dom: unsupported selector ${JSON.stringify(selector)}`);
    if (match[1] && node.tagName !== match[1].toUpperCase()) return false;
    return [...match[2].matchAll(SELECTOR_PART)].every(([, id, className, attribute, value]) => {
      if (id !== undefined) return node.getAttribute("id") === id;
      if (className !== undefined) return (node.getAttribute("class") || "").split(/\s+/).includes(className);
      const actual = node.getAttribute(attribute);
      return actual !== null && (value === undefined || actual === value);
    });
  });
}

function detach(node) {
  const parent = node.parentElement;
  if (parent) parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  node.parentElement = null;
}

// Tree links and computed properties are not enumerable, so util.inspect (and
// with it a failed assertion's message) shows a node's own state and markup
// instead of walking the whole page through every path between nodes.
const PARENT_LINK = { value: null, writable: true };

function textNode(value) {
  return Object.defineProperties({ nodeType: 3, textContent: value, remove() { detach(this); } }, { parentElement: PARENT_LINK });
}

// renderInbox() deps as the receiver passes them; only the GitHub connection
// changes which actions a card renders. The view only checks whether a
// receiver token is set (to render the logout form), so no token value is
// needed.
function renderInbox(items, { githubConfigured = true } = {}) {
  return createInboxView({
    formatScreenshotStatus: (screenshot) => screenshot.status,
    safeLinkUrl: (value) => /^https?:\/\//i.test(String(value || "").trim()) ? String(value).trim() : "",
    GITHUB_CONFIGURED: githubConfigured,
    RECEIVER_TOKEN: true
  }).renderInbox(items);
}

function parseDocument(html) {
  const document = {
    documentElement: null, head: null, body: null, activeElement: null,
    createElement: element,
    querySelector(selector) { return this.documentElement.querySelector(selector); },
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  };

  function element(tagName) {
    const attributes = new Map();
    const listeners = new Map();
    const toNode = (child) => typeof child === "string" ? textNode(child) : child;
    const node = {
      nodeType: 1, tagName: tagName.toUpperCase(), value: "",
      get outerHTML() {
        const name = this.tagName.toLowerCase();
        const markup = `<${name}${[...attributes].map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join("")}>`;
        if (VOID_TAGS.has(name)) return markup;
        return `${markup}${this.childNodes.map((child) => child.nodeType === 1 ? child.outerHTML : escapeText(child.textContent)).join("")}</${name}>`;
      },
      dataset: new Proxy({}, {
        get: (_, key) => typeof key === "string" ? attributes.get(dataAttribute(key)) : undefined,
        set(_, key, value) { attributes.set(dataAttribute(key), String(value)); return true; },
        deleteProperty(_, key) { attributes.delete(dataAttribute(key)); return true; }
      }),
      getAttribute: (name) => attributes.get(name) ?? null,
      hasAttribute: (name) => attributes.has(name),
      setAttribute: (name, value) => { attributes.set(name.toLowerCase(), String(value)); },
      removeAttribute: (name) => { attributes.delete(name); },
      addEventListener(type, callback) {
        listeners.set(type, [...(listeners.get(type) || []), callback]);
      },
      // Runs this element's listeners and returns what they return, so a test
      // can await async handlers. inbox.js listens on the controls themselves,
      // so events are not propagated.
      emit(type) {
        const event = { type, target: node, currentTarget: node, preventDefault() {} };
        return (listeners.get(type) || []).map((callback) => callback(event));
      },
      append(...children) {
        for (const child of children.map(toNode)) {
          child.remove();
          child.parentElement = this;
          this.childNodes.push(child);
        }
      },
      remove() {
        if (this.contains(document.activeElement)) document.activeElement = document.body;
        detach(this);
      },
      replaceWith(...nodes) {
        const parent = this.parentElement;
        if (!parent) return;
        const replacements = nodes.map(toNode);
        replacements.forEach((child) => child.remove());
        const index = parent.childNodes.indexOf(this);
        this.remove();
        replacements.forEach((child) => { child.parentElement = parent; });
        parent.childNodes.splice(index, 0, ...replacements);
      },
      replaceChildren(...children) {
        this.childNodes.slice().forEach((child) => child.remove());
        this.append(...children);
      },
      contains(candidate) { return candidate === this || this.children.some((child) => child.contains(candidate)); },
      // Only what a browser can focus takes focus: connected, enabled controls,
      // links with an href, and elements with a tabindex, outside hidden subtrees.
      focus() {
        const focusable = FORM_CONTROLS.has(this.tagName) || (this.tagName === "A" && this.hasAttribute("href")) || this.hasAttribute("tabindex");
        if (!focusable || !this.isConnected || (FORM_CONTROLS.has(this.tagName) && this.disabled)) return;
        for (let ancestor = this; ancestor; ancestor = ancestor.parentElement) if (ancestor.hidden) return;
        document.activeElement = this;
      },
      matches(selector) { return matchesSelector(this, selector); },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
      querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    };
    Object.defineProperties(node, {
      parentElement: PARENT_LINK,
      childNodes: { value: [], writable: true },
      children: { get() { return this.childNodes.filter((child) => child.nodeType === 1); } },
      textContent: {
        get() { return this.childNodes.map((child) => child.textContent).join(""); },
        set(value) { this.replaceChildren(...(String(value) ? [String(value)] : [])); }
      },
      isConnected: {
        get() {
          let top = this;
          while (top.parentElement) top = top.parentElement;
          return top === document.documentElement;
        }
      }
    });
    for (const name of REFLECTED_BOOLEANS) {
      Object.defineProperty(node, name, {
        get: () => attributes.has(name),
        set(value) {
          if (!value) attributes.delete(name);
          else if (!attributes.has(name)) attributes.set(name, "");
        },
        enumerable: true
      });
    }
    for (const name of REFLECTED_STRINGS) {
      Object.defineProperty(node, name, {
        get: () => attributes.get(name) ?? "",
        set(value) { attributes.set(name, String(value)); },
        enumerable: true
      });
    }
    if (node.tagName === "OPTION") {
      node.selected = false;
      Object.defineProperty(node, "value", { get: () => node.getAttribute("value") ?? node.textContent.trim(), enumerable: true });
    }
    // Like a browser, a select only takes a value one of its options has;
    // anything else leaves no option selected and an empty value.
    if (node.tagName === "SELECT") {
      Object.defineProperty(node, "value", {
        get: () => node.querySelectorAll("option").find((option) => option.selected)?.value ?? "",
        set(value) {
          let found = false;
          for (const option of node.querySelectorAll("option")) {
            option.selected = !found && option.value === String(value);
            found ||= option.selected;
          }
        },
        enumerable: true
      });
    }
    return node;
  }

  function finishMarkupElement(node) {
    if (node.tagName === "INPUT") node.value = node.getAttribute("value") ?? "";
    if (node.tagName === "OPTION") node.selected = node.hasAttribute("selected");
    if (node.tagName === "SELECT") {
      const options = node.querySelectorAll("option");
      if (options.length && !options.some((option) => option.selected)) options[0].selected = true;
    }
  }

  const root = element("template");
  const open = [root];
  for (const match of html.matchAll(TOKEN)) {
    const [, closing, tagName, attributeText = "", text, stray] = match;
    if (stray !== undefined) throw new Error(`inbox-dom: unparsed markup at ${JSON.stringify(html.slice(match.index, match.index + 40))}`);
    if (text !== undefined) {
      open.at(-1).append(decodeEntities(text));
    } else if (closing !== undefined) {
      if (open.length === 1 || open.at(-1).tagName !== closing.toUpperCase()) throw new Error(`inbox-dom: unexpected </${closing}> inside <${open.at(-1).tagName.toLowerCase()}>`);
      finishMarkupElement(open.pop());
    } else if (tagName !== undefined) {
      const node = element(tagName);
      for (const [, name, ...values] of attributeText.matchAll(ATTRIBUTE)) node.setAttribute(name, decodeEntities(values.find((value) => value !== undefined) ?? ""));
      open.at(-1).append(node);
      if (VOID_TAGS.has(tagName.toLowerCase())) finishMarkupElement(node);
      else open.push(node);
    }
  }
  if (open.length > 1) throw new Error(`inbox-dom: unclosed <${open.at(-1).tagName.toLowerCase()}>`);
  const [documentElement, ...rest] = root.children;
  if (!documentElement || documentElement.tagName !== "HTML" || rest.length) throw new Error("inbox-dom: the markup is not one <html> document");
  documentElement.remove();
  document.documentElement = documentElement;
  document.head = documentElement.querySelector("head");
  document.body = documentElement.querySelector("body");
  document.activeElement = document.body;
  return document;
}

// Runs inbox.js unchanged on the page renderInbox(items) draws. Requests are
// answered from `replies` in order ({ ok, status, body }).
function inboxHarness(items, { githubConfigured = true, replies = [], confirm = true } = {}) {
  const document = parseDocument(renderInbox(items, { githubConfigured }));
  const pending = replies.slice();
  const requests = [];
  const alerts = [];
  let reloads = 0;
  const window = {
    confirm: () => confirm,
    alert: (message) => alerts.push(message),
    location: { reload: () => { reloads += 1; } }
  };
  vm.runInNewContext(script, {
    document, window, URL,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const reply = pending.shift() || { ok: true, body: {} };
      return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    }
  });

  function get(selector, scope = document) {
    const node = scope.querySelector(selector);
    if (!node) throw new Error(`inbox-dom: ${selector} is not rendered`);
    return node;
  }
  return {
    document, window, requests, alerts, get,
    get reloads() { return reloads; },
    all: (selector, scope = document) => scope.querySelectorAll(selector),
    card: (id) => get(`[data-status-select][data-feedback-id="${id}"]`).closest("[data-card]"),
    // Like a browser, a disabled control dispatches no click at all.
    async click(node) {
      if (FORM_CONTROLS.has(node.tagName) && node.disabled) return;
      await Promise.all(node.emit("click"));
    },
    async change(select, value) {
      select.value = value;
      if (select.value !== value) throw new Error(`inbox-dom: ${JSON.stringify(value)} is not a rendered option`);
      await Promise.all(select.emit("change"));
    },
    async input(control, value) {
      control.value = value;
      await Promise.all(control.emit("input"));
    },
    async submit(form) {
      await Promise.all(form.emit("submit"));
    }
  };
}

module.exports = { script, renderInbox, parseDocument, inboxHarness };
