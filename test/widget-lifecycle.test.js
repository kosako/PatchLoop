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
    const node = {
      ...eventTarget(), tagName: tagName.toUpperCase(), children: [], parentElement: null,
      dataset: dataKey ? { [dataKey]: "" } : {}, style: {}, value: "", textContent: "", hidden: false, isConnected: true,
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
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.isConnected = false;
      },
      setAttribute() {}, removeAttribute() {}, focus() {},
      matches(selector) {
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
        if (!node.dataset.patchloopRoot) return;
        node.children = [];
        for (const key of ["plPanel", "plCollapse", "plMode", "plDownloadAll", "plClear", "plCancel", "plList", "plTooltip", "plHelp"]) node.append(element("div", key));
        const form = element("form", "plComment");
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
    ...eventTarget(), body: ready ? body : null, head, title: "Review page",
    documentElement: Object.assign(element("html"), { clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 600 }),
    createElement: element,
    elementFromPoint: () => target,
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return [...head.querySelectorAll(selector), ...(this.body?.querySelectorAll(selector) || [])]; },
    dispatchEvent(event) { this.emit(event.type, event); }
  };
  const requests = [];
  const warnings = [];
  const window = {
    ...eventTarget(), innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    location: { href: "https://demo.example/page" }, clearTimeout, setTimeout,
    localStorage: { getItem: () => null, setItem() {} }
  };
  vm.runInNewContext(bundle, {
    window, document, URL, navigator: { userAgent: "test", language: "ja" },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    console: { info() {}, warn: (...args) => warnings.push(args) },
    fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, status: 201 }; }
  });
  const api = window.PatchLoop;
  return {
    api, requests, warnings, document,
    init(options = {}) { api.init({ persistFeedback: false, captureScreenshot: false, reviewer: "Reviewer", endpoint: "https://receiver.example/feedback", ...options }); },
    ready() { document.body = body; document.emit("DOMContentLoaded"); },
    roots: () => document.querySelectorAll("[data-patchloop-root]"),
    mountCount: () => mountedRoots.length,
    async submit() {
      api.setFeedbackMode(true);
      const mouse = { target, button: 0, clientX: 20, clientY: 30 };
      document.emit("mousedown", mouse);
      document.emit("mouseup", mouse);
      document.querySelector("[data-pl-comment-text]").value = "Please fix this";
      document.querySelector("[data-pl-reviewer]").value = "Reviewer";
      await Promise.all(document.querySelector("[data-pl-comment]").emit("submit"));
    }
  };
}

test("destroy cancels initialization waiting for DOM readiness", () => {
  const widget = widgetHarness({ ready: false });
  widget.init();
  widget.api.destroy();
  widget.ready();
  assert.equal(widget.roots().length, 0);
});

test("repeated early init uses only the latest options and can be destroyed", async () => {
  const widget = widgetHarness({ ready: false });
  widget.init({ projectId: "first", onSubmit() { throw new Error("superseded callback"); } });
  widget.init({ projectId: "latest" });
  widget.ready();
  assert.equal(widget.roots().length, 1);
  assert.equal(widget.mountCount(), 1);
  await widget.submit();
  assert.equal(widget.requests.length, 1);
  assert.equal(JSON.parse(widget.requests[0].body).projectId, "latest");
  assert.equal(widget.warnings.length, 0);
  widget.api.destroy();
  assert.equal(widget.roots().length, 0);
  assert.equal(widget.document.querySelectorAll("[data-patchloop-pin]").length, 0);
});

for (const failure of ["synchronous", "asynchronous"]) {
  test(`${failure} onSubmit failure is reported and receiver delivery completes`, async () => {
    const widget = widgetHarness();
    const error = new Error(`${failure} callback failure`);
    widget.init({ onSubmit: failure === "synchronous" ? () => { throw error; } : () => Promise.reject(error) });
    await widget.submit();
    assert.equal(widget.requests.length, 1);
    assert.equal(widget.requests[0].url, "https://receiver.example/feedback");
    assert.equal(widget.api.getFeedback()[0].delivery.ok, true);
    assert.equal(widget.warnings.length, 1);
    assert.equal(widget.warnings[0][0], "[PatchLoop] onSubmit failed");
    assert.equal(widget.warnings[0][1], error);
  });
}

test("delivery does not wait for an unsettled onSubmit Promise", { timeout: 1000 }, async () => {
  const widget = widgetHarness();
  widget.init({ onSubmit: () => new Promise(() => {}) });
  await widget.submit();
  assert.equal(widget.requests.length, 1);
  assert.equal(widget.api.getFeedback()[0].delivery.ok, true);
});

test("onSubmit still runs synchronously before the payload is delivered", async () => {
  const widget = widgetHarness();
  widget.init({ onSubmit(payload) { payload.customContext = "from callback"; } });
  await widget.submit();
  assert.equal(JSON.parse(widget.requests[0].body).customContext, "from callback");
});

test("callback rejection does not interrupt direct Slack delivery", async () => {
  const widget = widgetHarness();
  widget.init({ deliveryMode: "slack-webhook", slackWebhookUrl: "https://hooks.slack.com/services/test", onSubmit: () => Promise.reject(new Error("callback failure")) });
  await widget.submit();
  assert.equal(widget.requests.length, 1);
  assert.equal(widget.requests[0].mode, "no-cors");
  assert.equal(widget.api.getFeedback()[0].delivery.target, "slack-webhook");
  assert.equal(widget.warnings.length, 1);
});
