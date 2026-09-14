"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const bundle = fs.readFileSync(path.join(__dirname, "../dist/patchloop-widget.js"), "utf8");

// The bundle runs unchanged against a small DOM adapter. These tests drive the
// public API and registered input/submit listeners; layout and screenshot
// fidelity belong to browser tests rather than this deterministic harness.
function widgetHarness() {
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
      },
      remove() {
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
    ...eventTarget(), body, head, title: "Review page", activeElement: body,
    documentElement: Object.assign(element("html"), { clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 600 }),
    createElement: element,
    elementFromPoint: () => target,
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return [...head.querySelectorAll(selector), ...(this.body?.querySelectorAll(selector) || [])]; },
    dispatchEvent(event) { this.emit(event.type, event); }
  };
  const requests = [];
  const storage = new Map();
  const window = {
    ...eventTarget(), innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    location: { href: "https://demo.example/page" }, clearTimeout, setTimeout,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  };
  vm.runInNewContext(bundle, {
    window, document, URL, navigator: { userAgent: "test", language: "ja" },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    console: { info() {}, warn() {} },
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
    api, requests, document, capture,
    init(options = {}) { api.init({ persistFeedback: false, captureScreenshot: false, reviewer: "Reviewer", endpoint: "https://receiver.example/feedback", ...options }); },
    async submit(comment = "Please fix this", { area = false, captureTarget = true } = {}) {
      if (captureTarget) capture(area);
      document.querySelector("[data-pl-comment-text]").value = comment;
      document.querySelector("[data-pl-reviewer]").value = "Reviewer";
      await Promise.all(document.querySelector("[data-pl-comment]").emit("submit"));
    }
  };
}

test("point and area markers have descriptive names and focusable labels", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Point comment");
  await widget.submit("Area comment", { area: true });
  const point = widget.document.querySelector("[data-patchloop-pin]");
  const area = widget.document.querySelector("[data-patchloop-area]").querySelector("button");
  assert.equal(point.tagName, "BUTTON");
  assert.equal(point.getAttribute("aria-label"), "点のフィードバック 1: Point comment");
  assert.ok(area, "area marker must have a native keyboard-focusable label");
  assert.equal(area.type, "button");
  assert.equal(area.getAttribute("aria-label"), "範囲のフィードバック 2: Area comment");
});

test("marker focus displays its tooltip, which stays through mouseleave and closes with Escape or blur", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Keyboard-readable comment");
  widget.api.setFeedbackMode(false);
  const point = widget.document.querySelector("[data-patchloop-pin]");
  const tooltip = widget.document.querySelector("[data-pl-tooltip]");
  point.focus();
  assert.equal(tooltip.getAttribute("role"), "tooltip");
  assert.equal(point.getAttribute("aria-describedby"), tooltip.getAttribute("id"));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, "Reviewer\nKeyboard-readable comment");
  assert.match(tooltip.style.left, /^\d+px$/);
  assert.match(tooltip.style.top, /^\d+px$/);
  point.emit("mouseleave");
  assert.equal(tooltip.hidden, false);
  point.emit("keydown", { key: "Escape" });
  assert.equal(tooltip.hidden, true);
  assert.equal(widget.document.activeElement, point);
  widget.document.querySelector("[data-pl-collapse]").focus();
  point.focus();
  assert.equal(tooltip.hidden, false);
  widget.document.querySelector("[data-pl-collapse]").focus();
  assert.equal(tooltip.hidden, true);
});

test("Escape cancels a pending comment and restores focus to the previous control", () => {
  const widget = widgetHarness();
  widget.init();
  const trigger = widget.document.querySelector("[data-pl-collapse]");
  trigger.focus();
  widget.capture();
  const form = widget.document.querySelector("[data-pl-comment]");
  assert.equal(widget.document.activeElement, form.querySelector("[data-pl-comment-text]"));
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 1);
  form.emit("keydown", { key: "Escape" });
  assert.equal(form.hidden, true);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 0);
  assert.equal(widget.api.getFeedback().length, 0);
  assert.equal(widget.requests.length, 0);
  assert.equal(widget.document.activeElement, trigger);
});

test("Escape during IME composition does not cancel a comment", () => {
  const widget = widgetHarness();
  widget.init();
  widget.capture();
  const form = widget.document.querySelector("[data-pl-comment]");
  form.emit("keydown", { key: "Escape", isComposing: true });
  assert.equal(form.hidden, false);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 1);
});

test("canceling an edit preserves the comment and returns focus to its edit button", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("Original comment");
  const edit = widget.document.querySelector("[data-pl-edit]");
  edit.focus();
  widget.document.querySelector("[data-pl-list]").emit("click", { target: edit });
  const form = widget.document.querySelector("[data-pl-comment]");
  form.querySelector("[data-pl-comment-text]").value = "Canceled edit";
  form.emit("keydown", { key: "Escape" });
  assert.equal(widget.api.getFeedback()[0].comment, "Original comment");
  assert.equal(widget.document.activeElement, edit);
  assert.equal(form.hidden, true);
});

test("editing and deleting comments refresh marker names and restore focus after rerender", async () => {
  const widget = widgetHarness();
  widget.init();
  await widget.submit("First comment");
  await widget.submit("Second comment");
  const edit = widget.document.querySelector("[data-pl-edit]");
  edit.focus();
  widget.document.querySelector("[data-pl-list]").emit("click", { target: edit });
  await widget.submit("Updated comment", { captureTarget: false });
  const points = widget.document.querySelectorAll("[data-patchloop-pin]");
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 2: Updated comment");
  assert.equal(widget.document.activeElement, widget.document.querySelector("[data-pl-collapse]"));
  const oldestCard = widget.document.querySelectorAll("[data-feedback-id]")[1];
  widget.document.querySelector("[data-pl-list]").emit("click", { target: oldestCard.querySelector("[data-pl-delete]") });
  assert.equal(points[1].getAttribute("aria-label"), "点のフィードバック 1: Updated comment");
});

test("restored markers retain accessible names and focus tooltips", async () => {
  const widget = widgetHarness();
  widget.init({ persistFeedback: true });
  await widget.submit("Persisted comment", { area: true });
  widget.api.destroy();
  widget.init({ persistFeedback: true });
  const label = widget.document.querySelector("[data-patchloop-area]").querySelector("button");
  assert.equal(label.getAttribute("aria-label"), "範囲のフィードバック 1: Persisted comment");
  label.focus();
  assert.equal(widget.document.querySelector("[data-pl-tooltip]").hidden, false);
});

function rgb(hex) {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((char) => char + char).join("") : digits;
  assert.match(full, /^[\da-f]{6}$/i);
  return full.match(/../g).map((value) => parseInt(value, 16) / 255);
}

function luminance(color) {
  const [red, green, blue] = color.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("normal text and marker badges meet 4.5:1, including exported cards", () => {
  const widget = widgetHarness();
  widget.init();
  const css = widget.document.querySelector("[data-patchloop-style]").textContent;
  const rules = new Map([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
    match[1].trim(), Object.fromEntries(match[2].split(";").filter((part) => part.trim()).map((part) => part.split(":").map((value) => value.trim())))
  ]));
  for (const selector of [".pl-pin", ".pl-area button", ".pl-mode", ".pl-handle.pl-mode-on"]) {
    const rule = rules.get(selector);
    assert.ok(contrast(rgb(rule.color), rgb(rule.background)) >= 4.5, selector);
  }
  assert.ok(contrast(rgb(rules.get(".pl-handle.pl-mode-on").color), rgb(rules.get(".pl-handle.pl-mode-on:hover").background)) >= 4.5, "active handle hover");
  const numberColor = rules.get(".pl-feedback-num").color;
  for (const kind of ["point", "area"]) {
    assert.ok(contrast(rgb(numberColor), rgb(rules.get(`.pl-feedback-num.kind-${kind}`).background)) >= 4.5, `${kind} number`);
  }
  const card = rules.get(".pl-feedback-item");
  const exported = rules.get(".pl-feedback-item-exported");
  const alpha = Number(exported.opacity ?? 1);
  const composite = (color) => color.map((value, index) => value * alpha + rgb(card.background)[index] * (1 - alpha));
  for (const selector of [".pl-feedback-text", ".pl-feedback-meta", ".pl-feedback-status-unknown", ".pl-feedback-status-fail", ".pl-feedback-approx", ".pl-feedback-exported", ".pl-feedback-actions [data-pl-delete]"]) {
    const color = rgb(rules.get(selector).color);
    assert.ok(contrast(color, rgb(card.background)) >= 4.5, selector);
    assert.ok(contrast(composite(color), composite(rgb(exported.background || card.background))) >= 4.5, `${selector} in exported card`);
  }
});
