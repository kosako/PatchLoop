"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bundle = fs.readFileSync(path.join(__dirname, "../dist/patchloop-widget.js"), "utf8");

// Markup assigned through innerHTML is parsed into elements, so the hooks the
// tests reach (data-* attributes, hidden/checked/disabled/selected, value)
// are exactly the ones the widget's template renders. The parser is strict:
// markup it cannot read, mismatched or unclosed tags, and selectors it cannot
// evaluate throw instead of silently matching nothing.
const VOID_TAGS = new Set(["br", "hr", "img", "input", "link", "meta"]);
const BOOLEAN_PROPERTIES = new Set(["checked", "disabled", "hidden", "required", "selected"]);
// Like a browser, these properties are their attribute: setting the property
// adds or removes the attribute, and attribute changes show in the property,
// so [disabled] / [hidden] selectors, click() and focus() agree. checked and
// selected stay plain properties, as in a browser their attribute is only the
// initial state.
const REFLECTED_BOOLEANS = ["disabled", "hidden", "required"];
const REFLECTED_PROPERTIES = new Set(["id", "type", "value"]);
const FORM_CONTROLS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const TOKEN = /<!--[\s\S]*?-->|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>|([^<]+)|([\s\S])/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g;
const SELECTOR = /^([a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|:hover)*)$/i;
const SELECTOR_PART = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(:hover)/g;

const decodeEntities = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
  if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
  return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
});
const datasetKey = (attribute) => attribute.slice("data-".length).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function matchesSelector(node, selector) {
  return selector.split(",").some((alternative) => {
    const simple = alternative.trim();
    const match = simple && SELECTOR.exec(simple);
    if (!match) throw new Error(`widget-dom: unsupported selector ${JSON.stringify(selector)}`);
    if (match[1] && node.tagName !== match[1].toUpperCase()) return false;
    return [...match[2].matchAll(SELECTOR_PART)].every(([, id, className, attribute, value, hover]) => {
      if (id !== undefined) return node.id === id;
      if (className !== undefined) return node.classList.contains(className);
      if (hover) return Boolean(node.hovered);
      // id and type set as properties still match, as they reflect to attributes.
      const actual = attribute.startsWith("data-")
        ? node.dataset[datasetKey(attribute)]
        : node.getAttribute(attribute) ?? ((attribute === "id" || attribute === "type") && node[attribute] ? String(node[attribute]) : null);
      return actual !== undefined && actual !== null && (value === undefined || actual === value);
    });
  });
}

// The bundle runs unchanged against a small DOM adapter. These tests drive the
// public API and registered input/submit listeners; layout and screenshot
// fidelity belong to browser tests rather than this deterministic harness.
// The inbox status lookup (#147) answers 404 unless a test supplies statusReply
// ((query, fetchOptions) => response), like a receiver without the lookup.
const NO_STATUS_LOOKUP = () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: "Not Found" }) });

// timers replaces the page's setTimeout / clearTimeout, for tests that fire a
// timeout themselves.
function widgetHarness({ ready = true, pointerEvents = false, replies = [], statusReply = NO_STATUS_LOOKUP, timers = { setTimeout, clearTimeout } } = {}) {
  const mountedRoots = [];
  const downloads = [];
  const blobs = new Map();
  function eventTarget() {
    const listeners = new Map();
    const isCapture = (options) => options === true || Boolean(options?.capture);
    return {
      addEventListener(type, callback, options) {
        const capture = isCapture(options);
        const current = listeners.get(type) || [];
        if (!current.some((entry) => entry.callback === callback && entry.capture === capture)) current.push({ callback, capture, once: options?.once });
        listeners.set(type, current);
      },
      removeEventListener(type, callback, options) {
        const capture = isCapture(options);
        listeners.set(type, (listeners.get(type) || []).filter((entry) => entry.callback !== callback || entry.capture !== capture));
      },
      // Runs this node's listeners for `type`: all of them, or only the
      // capture (true) or bubble (false) ones when dispatching along a path.
      emit(type, values = {}, capture) {
        if (type === "mouseenter") this.hovered = true;
        if (type === "mouseleave") this.hovered = false;
        const event = { preventDefault() {}, stopPropagation() {}, currentTarget: this, ...values };
        return (listeners.get(type) || []).filter((entry) => capture === undefined || entry.capture === capture).map((entry) => {
          if (entry.once) this.removeEventListener(type, entry.callback, entry.capture);
          return entry.callback(event);
        });
      }
    };
  }

  // A bubbling event: capture listeners from the document down to the target,
  // then bubble listeners back up, until a listener stops propagation.
  function dispatch(target, type) {
    const path = [];
    for (let node = target; node; node = node.parentElement) path.unshift(node);
    if (target.isConnected) path.unshift(document);
    let stopped = false;
    const values = { target, stopPropagation() { stopped = true; } };
    for (const [nodes, capture] of [[path, true], [path.slice().reverse(), false]]) {
      for (const node of nodes) {
        node.emit(type, { ...values, currentTarget: node }, capture);
        if (stopped) return;
      }
    }
  }

  function element(tagName = "div") {
    const classes = new Set();
    const attributes = new Map();
    const node = {
      ...eventTarget(), tagName: tagName.toUpperCase(), localName: tagName.toLowerCase(), children: [], parentElement: null,
      dataset: {}, style: {}, value: "", textContent: "",
      get isConnected() { return this.tagName === "BODY" || this.tagName === "HEAD" || Boolean(this.parentElement?.isConnected); },
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
        toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        [Symbol.iterator]: () => classes.values()
      },
      append(child) {
        this.children.push(child);
        child.parentElement = this;
        if (child.dataset.patchloopRoot) mountedRoots.push(child);
      },
      remove() {
        if (this.contains(document.activeElement)) document.activeElement = document.body;
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
        if (name.startsWith("data-")) this.dataset[datasetKey(name)] = String(value);
      },
      // Like a browser, a disabled control dispatches no click at all.
      click() {
        if (FORM_CONTROLS.has(this.tagName) && this.disabled) return;
        if (this.tagName === "A" && this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) });
        dispatch(this, "click");
      },
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute(name) {
        attributes.delete(name);
        if (name.startsWith("data-")) delete this.dataset[datasetKey(name)];
      },
      contains(candidate) { return candidate === this || this.children.some((child) => child.contains(candidate)); },
      // Disabled controls and anything inside a hidden subtree cannot take focus.
      focus() {
        if (!this.isConnected || (FORM_CONTROLS.has(this.tagName) && this.disabled)) return;
        for (let ancestor = this; ancestor; ancestor = ancestor.parentElement) if (ancestor.hidden) return;
        document.activeElement?.emit("blur");
        document.activeElement = this;
        this.emit("focus");
      },
      matches(selector) { return matchesSelector(this, selector); },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
      querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }; }
    };
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
    if (node.tagName === "INPUT") node.checked = false;
    if (node.tagName === "OPTION") node.selected = false;
    let html = "";
    Object.defineProperty(node, "innerHTML", {
      get: () => html,
      set(value) {
        html = value;
        node.children.slice().forEach((child) => child.remove());
        parseInto(node, value);
      }
    });
    return node;
  }

  function setMarkupAttribute(node, name, value) {
    node.setAttribute(name, value);
    if (name.startsWith("data-")) node.dataset[datasetKey(name)] = value;
    else if (name === "class") value.split(/\s+/).filter(Boolean).forEach((className) => node.classList.add(className));
    else if (BOOLEAN_PROPERTIES.has(name)) node[name] = true;
    else if (REFLECTED_PROPERTIES.has(name)) node[name] = value;
  }

  function finishMarkupElement(node) {
    if (node.tagName === "TEXTAREA") node.value = node.textContent;
    if (node.tagName === "OPTION" && node.getAttribute("value") === null) node.value = node.textContent.trim();
    if (node.tagName === "SELECT") {
      const options = node.querySelectorAll("option");
      node.value = (options.find((option) => option.selected) || options[0])?.value ?? "";
    }
  }

  function parseInto(parent, markup) {
    const open = [parent];
    parent.textContent = "";
    for (const match of markup.matchAll(TOKEN)) {
      const [, closing, tagName, attributeText = "", text, stray] = match;
      if (stray !== undefined) throw new Error(`widget-dom: unparsed markup at ${JSON.stringify(markup.slice(match.index, match.index + 40))}`);
      if (text !== undefined) {
        const decoded = decodeEntities(text);
        open.forEach((node) => { node.textContent += decoded; });
      } else if (closing !== undefined) {
        if (open.length === 1 || open.at(-1).tagName !== closing.toUpperCase()) throw new Error(`widget-dom: unexpected </${closing}> inside <${open.at(-1).tagName.toLowerCase()}>`);
        finishMarkupElement(open.pop());
      } else if (tagName !== undefined) {
        const node = element(tagName);
        for (const [, name, ...values] of attributeText.matchAll(ATTRIBUTE)) setMarkupAttribute(node, name.toLowerCase(), decodeEntities(values.find((value) => value !== undefined) ?? ""));
        open.at(-1).append(node);
        if (VOID_TAGS.has(tagName.toLowerCase())) finishMarkupElement(node);
        else open.push(node);
      }
    }
    if (open.length > 1) throw new Error(`widget-dom: unclosed <${open.at(-1).tagName.toLowerCase()}>`);
  }

  const body = element("body");
  const head = element("head");
  const target = element("button");
  target.id = "review-target";
  target.textContent = "Review target";
  body.append(target);
  const document = {
    ...eventTarget(), body: ready ? body : null, head, title: "Review page", activeElement: ready ? body : null,
    baseURI: "https://demo.example/page",
    documentElement: Object.assign(element("html"), { clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 600 }),
    createElement: element,
    elementFromPoint: () => target,
    // Nothing on top at a point: the uncaptured detection then relies on boxes.
    elementsFromPoint: () => [],
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return [...head.querySelectorAll(selector), ...(this.body?.querySelectorAll(selector) || [])]; },
    dispatchEvent(event) { this.emit(event.type, event); }
  };
  const requests = [];
  const statusRequests = [];
  const warnings = [];
  const infos = [];
  const storage = new Map();
  const window = {
    ...eventTarget(), innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    location: { href: "https://demo.example/page" }, clearTimeout: timers.clearTimeout, setTimeout: timers.setTimeout,
    confirm: () => true,
    ...(pointerEvents ? { PointerEvent: function () {} } : {}),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  };
  vm.runInNewContext(bundle, {
    window, document, Blob, AbortController,
    URL: class extends URL {
      static createObjectURL(blob) { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }
      static revokeObjectURL() {}
    },
    navigator: { userAgent: "test", language: "ja" },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    console: { info: (...args) => infos.push(args), warn: (...args) => warnings.push(args) },
    fetch: async (url, options) => {
      // Status lookups get their own reply and record, so tests that count
      // deliveries in requests are not affected by them.
      if (String(url).endsWith("/feedback-status")) {
        statusRequests.push({ url, ...options });
        return statusReply(JSON.parse(options.body), options);
      }
      requests.push({ url, ...options });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (typeof reply === "function") return reply(options);
      return reply || { ok: true, status: 201 };
    }
  });
  const api = window.PatchLoop;
  function capture(area = false) {
    api.setFeedbackMode(true);
    const mouse = { target, button: 0, clientX: 20, clientY: 30 };
    document.emit(pointerEvents ? "pointerdown" : "mousedown", mouse);
    if (area) document.emit(pointerEvents ? "pointermove" : "mousemove", { ...mouse, buttons: 1, clientX: 100, clientY: 80 });
    document.emit(pointerEvents ? "pointerup" : "mouseup", area ? { ...mouse, clientX: 100, clientY: 80 } : mouse);
  }
  return {
    api, requests, statusRequests, warnings, infos, document, window, capture, downloads, target,
    init(options = {}) { api.init({ persistFeedback: false, captureScreenshot: false, reviewer: "Reviewer", endpoint: "https://receiver.example/feedback", ...options }); },
    ready() { document.body = body; document.activeElement = body; document.emit("DOMContentLoaded"); },
    roots: () => document.querySelectorAll("[data-patchloop-root]"),
    mountCount: () => mountedRoots.length,
    async submit(comment = "Please fix this", { area = false, captureTarget = true } = {}) {
      if (captureTarget) capture(area);
      document.querySelector("[data-pl-comment-text]").value = comment;
      document.querySelector("[data-pl-reviewer]").value = "Reviewer";
      await Promise.all(document.querySelector("[data-pl-comment]").emit("submit"));
    }
  };
}


module.exports = { bundle, widgetHarness };
