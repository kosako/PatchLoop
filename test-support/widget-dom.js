"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bundle = fs.readFileSync(path.join(__dirname, "../dist/patchloop-widget.js"), "utf8");

// The bundle runs unchanged against a small DOM adapter. These tests drive the
// public API and registered input/submit listeners; layout and screenshot
// fidelity belong to browser tests rather than this deterministic harness.
function widgetHarness({ ready = true } = {}) {
  const mountedRoots = [];
  function eventTarget() {
    const listeners = new Map();
    return {
      addEventListener(type, callback, options) {
        const current = listeners.get(type) || [];
        if (!current.some((entry) => entry.callback === callback)) current.push({ callback, once: options?.once });
        listeners.set(type, current);
      },
      removeEventListener(type, callback) {
        listeners.set(type, (listeners.get(type) || []).filter((entry) => entry.callback !== callback));
      },
      emit(type, values = {}) {
        if (type === "mouseenter") this.hovered = true;
        if (type === "mouseleave") this.hovered = false;
        const event = { preventDefault() {}, stopPropagation() {}, currentTarget: this, ...values };
        return (listeners.get(type) || []).slice().map((entry) => {
          if (entry.once) this.removeEventListener(type, entry.callback);
          return entry.callback(event);
        });
      }
    };
  }

  const selectorDataset = (selector) => /^\[data-([\w-]+)\]$/.exec(selector)?.[1]
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

  function element(tagName = "div", dataKey) {
    const classes = new Set();
    const attributes = new Map();
    const node = {
      ...eventTarget(), tagName: tagName.toUpperCase(), children: [], parentElement: null,
      dataset: dataKey ? { [dataKey]: "" } : {}, style: {}, value: "", textContent: "", hidden: false,
      get isConnected() { return this.tagName === "BODY" || this.tagName === "HEAD" || Boolean(this.parentElement?.isConnected); },
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
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
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute: (name) => attributes.delete(name),
      contains(candidate) { return candidate === this || this.children.some((child) => child.contains(candidate)); },
      focus() {
        if (!this.isConnected || this.hidden) return;
        document.activeElement?.emit("blur");
        document.activeElement = this;
        this.emit("focus");
      },
      matches(selector) {
        if (selector === ":hover") return Boolean(this.hovered);
        if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
        if (selector.startsWith(".")) return classes.has(selector.slice(1));
        const key = selectorDataset(selector);
        return key !== undefined && Object.hasOwn(this.dataset, key);
      },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
      querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }; }
    };
    let html = "";
    Object.defineProperty(node, "innerHTML", {
      get: () => html,
      set(value) {
        html = value;
        if (Object.hasOwn(node.dataset, "plList")) {
          node.children.slice().forEach((child) => child.remove());
          for (const match of value.matchAll(/<article[^>]*data-feedback-id="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)) {
            const article = element("article", "feedbackId");
            article.dataset.feedbackId = match[1];
            for (const button of match[2].matchAll(/<button[^>]*data-pl-(edit|delete)[^>]*>/g)) article.append(element("button", button[1] === "edit" ? "plEdit" : "plDelete"));
            node.append(article);
          }
          return;
        }
        if (!node.dataset.patchloopRoot) return;
        node.children = [];
        for (const key of ["plPanel", "plCollapse", "plMode", "plDownloadAll", "plClear", "plCancel", "plList", "plTooltip", "plHelp"]) node.append(element("div", key));
        const tooltipMarkup = /<div[^>]*data-pl-tooltip[^>]*>/.exec(value)[0];
        for (const attribute of tooltipMarkup.matchAll(/(id|role)="([^"]+)"/g)) node.querySelector("[data-pl-tooltip]").setAttribute(attribute[1], attribute[2]);
        node.querySelector("[data-pl-tooltip]").hidden = true;
        const form = element("form", "plComment");
        form.hidden = true;
        for (const key of ["plCommentText", "plReviewer", "plFormError"]) form.append(element("input", key));
        node.append(form);
      }
    });
    return node;
  }

  const body = element("body");
  const head = element("head");
  const target = element("button");
  target.id = "review-target";
  target.textContent = "Review target";
  body.append(target);
  const document = {
    ...eventTarget(), body: ready ? body : null, head, title: "Review page", activeElement: ready ? body : null,
    documentElement: Object.assign(element("html"), { clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 600 }),
    createElement: element,
    elementFromPoint: () => target,
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return [...head.querySelectorAll(selector), ...(this.body?.querySelectorAll(selector) || [])]; },
    dispatchEvent(event) { this.emit(event.type, event); }
  };
  const requests = [];
  const warnings = [];
  const storage = new Map();
  const window = {
    ...eventTarget(), innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    location: { href: "https://demo.example/page" }, clearTimeout, setTimeout,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  };
  vm.runInNewContext(bundle, {
    window, document, URL, navigator: { userAgent: "test", language: "ja" },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    console: { info() {}, warn: (...args) => warnings.push(args) },
    fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, status: 201 }; }
  });
  const api = window.PatchLoop;
  function capture(area = false) {
    api.setFeedbackMode(true);
    const mouse = { target, button: 0, clientX: 20, clientY: 30 };
    document.emit("mousedown", mouse);
    if (area) document.emit("mousemove", { ...mouse, buttons: 1, clientX: 100, clientY: 80 });
    document.emit("mouseup", area ? { ...mouse, clientX: 100, clientY: 80 } : mouse);
  }
  return {
    api, requests, warnings, document, capture,
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


module.exports = { widgetHarness };
