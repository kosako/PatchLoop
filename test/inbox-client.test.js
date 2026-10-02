"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../server/static/inbox.js"), "utf8");

test("status success reapplies the selected filter and updates the visible count", async () => {
  const ui = createInbox([{ id: "one", status: "new" }, { id: "two", status: "fixed" }]);
  ui.statusFilter.value = "new";
  await ui.statusFilter.fire("change");
  assert.equal(ui.count.textContent, "1 / 2 件");
  const card = ui.cards[0];
  card.statusSelect.value = "fixed";
  const update = card.statusSelect.fire("change");
  assert.equal(card.statusSelect.disabled, true);
  await update;
  assert.equal(card.dataset.status, "fixed");
  assert.equal(card.hidden, true);
  assert.equal(card.statusSelect.disabled, false);
  assert.equal(ui.count.textContent, "0 / 2 件");
  assert.equal(ui.total.textContent, "2");
  assert.equal(ui.filteredEmpty.hidden, false);
  assert.equal(ui.inboxEmpty.hidden, true);
  assert.deepEqual(JSON.parse(ui.requests[0].options.body), { status: "fixed" });
});

test("a rejected status edit restores the selection and preserves the list", async () => {
  const ui = createInbox([{ id: "one", status: "new" }], { replies: [{ ok: false, body: { error: "Status rejected" } }] });
  ui.statusFilter.value = "new";
  await ui.statusFilter.fire("change");
  const card = ui.cards[0];
  card.statusSelect.value = "fixed";
  await card.statusSelect.fire("change");
  assert.equal(card.dataset.status, "new");
  assert.equal(card.statusSelect.value, "new");
  assert.equal(card.statusSelect.disabled, false);
  assert.equal(card.hidden, false);
  assert.equal(ui.count.textContent, "1 件");
  assert.equal(card.message.textContent, "Status rejected");
  assert.equal(card.message.dataset.state, "error");
  assert.deepEqual(ui.alerts, []);
});

test("deletion counts the live cards and distinguishes no matches from an empty inbox", async () => {
  const ui = createInbox([{ id: "one", status: "new" }, { id: "two", status: "fixed" }]);
  ui.statusFilter.value = "new";
  await ui.statusFilter.fire("change");
  await ui.cards[0].deleteButton.fire("click");
  assert.equal(ui.cards.length, 1);
  assert.equal(ui.total.textContent, "1");
  assert.equal(ui.count.textContent, "0 / 1 件");
  assert.equal(ui.filteredEmpty.hidden, false);
  assert.equal(ui.inboxEmpty.hidden, true);
  assert.equal(ui.panel.hidden, false);

  ui.statusFilter.value = "";
  await ui.statusFilter.fire("change");
  assert.equal(ui.count.textContent, "1 件");
  await ui.cards[0].deleteButton.fire("click");
  assert.equal(ui.cards.length, 0);
  assert.equal(ui.total.textContent, "0");
  assert.equal(ui.count.textContent, "0 件");
  assert.equal(ui.inboxEmpty.hidden, false);
  assert.equal(ui.filteredEmpty.hidden, true);
  assert.equal(ui.panel.hidden, true);
});

test("a failed or cancelled deletion preserves cards and counts", async () => {
  const failed = createInbox([{ id: "one", status: "new" }], { replies: [{ ok: false, body: { error: "Deletion rejected" } }] });
  const card = failed.cards[0];
  await card.deleteButton.fire("click");
  assert.equal(failed.cards.length, 1);
  assert.equal(failed.total.textContent, "1");
  assert.equal(failed.count.textContent, "1 件");
  assert.equal(card.deleteButton.disabled, false);
  assert.equal(card.deleteButton.textContent, "削除");
  assert.equal(card.message.textContent, "Deletion rejected");
  assert.equal(card.message.dataset.state, "error");
  assert.deepEqual(failed.alerts, []);

  const cancelled = createInbox([{ id: "one", status: "new" }], { confirm: false });
  await cancelled.cards[0].deleteButton.fire("click");
  assert.equal(cancelled.requests.length, 0);
  assert.equal(cancelled.cards.length, 1);
  assert.equal(cancelled.total.textContent, "1");
});

test("text search continues to use the remaining cards after a deletion", async () => {
  const ui = createInbox([{ id: "alpha", status: "new" }, { id: "beta", status: "new" }]);
  await ui.cards[0].deleteButton.fire("click");
  ui.search.value = " ALPHA ";
  await ui.search.fire("input");
  assert.equal(ui.count.textContent, "0 / 1 件");
  assert.equal(ui.filteredEmpty.hidden, false);
  ui.search.value = "BETA";
  await ui.search.fire("input");
  assert.equal(ui.count.textContent, "1 件");
  assert.equal(ui.filteredEmpty.hidden, true);
});

test("an initially empty inbox does not require a filter panel", () => {
  const ui = createInbox([]);
  assert.equal(ui.total.textContent, "0");
  assert.equal(ui.inboxEmpty.hidden, false);
  assert.equal(ui.filteredEmpty.hidden, true);
});

test("import reports missing files, duplicate results, and failed requests", async () => {
  const missing = createInbox([]);
  await missing.form.fire("submit");
  assert.equal(missing.importStatus.dataset.state, "error");
  assert.equal(missing.requests.length, 0);

  const duplicate = createInbox([], { replies: [{ ok: false, body: { imported: 0, duplicates: ["existing"], failed: [] } }] });
  duplicate.file.files = [{ text: async () => "{}" }];
  await duplicate.form.fire("submit");
  assert.match(duplicate.importStatus.textContent, /重複 1 件はスキップ/);
  assert.equal(duplicate.reloads, 0);

  const failed = createInbox([], { replies: [{ ok: false, body: { error: "Import rejected" } }] });
  failed.file.files = [{ text: async () => "{}" }];
  await failed.form.fire("submit");
  assert.equal(failed.importStatus.textContent, "Import rejected");
  assert.equal(failed.importStatus.dataset.state, "error");
});

test("sidebar counts follow triage changes and reset restores search and status", async () => {
  const ui = createInbox([{ id: "alpha", status: "new" }, { id: "beta", status: "fixed" }]);
  await ui.navigation[1].fire("click");
  assert.equal(ui.statusFilter.value, "new");
  assert.equal(ui.navigation[1].attributes["aria-pressed"], "true");
  ui.search.value = "missing";
  await ui.search.fire("input");
  assert.equal(ui.navigation[0].badge.textContent, "2");
  await ui.reset.fire("click");
  assert.equal(ui.count.textContent, "2 件");
  assert.equal(ui.search.focused, true);
  ui.cards[0].statusSelect.value = "fixed";
  await ui.cards[0].statusSelect.fire("change");
  assert.equal(ui.navigation[1].badge.textContent, "0");
  assert.equal(ui.navigation[3].badge.textContent, "2");
});

test("partial import stays visible and blocks a concurrent submission", async () => {
  const ui = createInbox([], { replies: [{ ok: true, body: { imported: 1, duplicates: ["one"], failed: [{ error: "invalid" }] } }] });
  let finishReading;
  ui.file.files = [{ text: () => new Promise((resolve) => { finishReading = resolve; }) }];
  const first = ui.form.fire("submit");
  assert.equal(ui.submit.disabled, true);
  await ui.form.fire("submit");
  finishReading("{}");
  await first;
  assert.equal(ui.requests.length, 1);
  assert.match(ui.importStatus.textContent, /1 件を追加.*重複 1 件.*失敗 1 件/);
  assert.equal(ui.importStatus.dataset.state, "error");
  assert.equal(ui.reload.hidden, false);
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.reloads, 0);
  await ui.reload.fire("click");
  assert.equal(ui.reloads, 1);
});

test("expired sessions and throttling preserve the user's filter and selection", async () => {
  for (const [status, expected] of [[401, /ログイン/], [429, /しばらく待って/]]) {
    const ui = createInbox([{ id: "one", status: "new" }], { replies: [{ ok: false, status, body: {} }] });
    ui.search.value = "one";
    ui.cards[0].statusSelect.value = "fixed";
    await ui.cards[0].statusSelect.fire("change");
    assert.equal(ui.search.value, "one");
    assert.equal(ui.cards[0].statusSelect.value, "new");
    assert.match(ui.cards[0].message.textContent, expected);
  }
});

test("GitHub creation and existing-issue recovery replace the action with a safe link", async () => {
  for (const status of [201, 409]) {
    const ui = createInbox([{ id: "one", status: "new" }], { replies: [{ ok: status === 201, status,
      body: { github: { issueNumber: 42, url: "https://github.com/example/demo/issues/42" } } }] });
    await ui.cards[0].githubButton.fire("click");
    assert.equal(ui.cards[0].githubLink.href, "https://github.com/example/demo/issues/42");
    assert.equal(ui.cards[0].githubLink.focused, true);
    assert.equal(ui.cards[0].dataset.github, "created");
    assert.equal(ui.reloads, 0);
  }
});

test("an invalid created-issue URL never enables duplicate creation or an unsafe link", async () => {
  const ui = createInbox([{ id: "one", status: "new" }], { replies: [{ ok: true,
    body: { github: { issueNumber: 42, url: "javascript:alert(1)" } } }] });
  await ui.cards[0].githubButton.fire("click");
  assert.equal(ui.cards[0].githubLink, undefined);
  assert.equal(ui.cards[0].githubButton.disabled, true);
  assert.match(ui.cards[0].message.textContent, /ページを更新/);
});

function element(properties = {}) {
  const listeners = new Map();
  return {
    dataset: {}, value: "", hidden: false, disabled: false, textContent: "",
    attributes: {}, focused: false,
    focus() { this.focused = true; },
    setAttribute(name, value) { this.attributes[name] = value; },
    ...properties,
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    async fire(type) {
      for (const callback of listeners.get(type) || []) await callback({ preventDefault() {} });
    }
  };
}

function createInbox(rows, options = {}) {
  const ui = {
    cards: [], requests: [], alerts: [], reloads: 0,
    total: element(), count: element(), search: element(),
    inboxEmpty: element({ hidden: rows.length > 0 }), filteredEmpty: element({ hidden: true }),
    importStatus: element(), file: element({ files: [] }),
    message: element(), submit: element(), reload: element({ hidden: true }), reset: element(),
    statusFilter: element({ dataset: { filterKey: "status" } })
  };
  ui.navigation = ["", "new", "accepted", "fixed", "ignored"].map((status) => {
    const badge = element();
    return element({ dataset: { statusNav: status }, badge, querySelector: () => badge });
  });
  for (const row of rows) {
    const message = element();
    const card = element({ dataset: { status: row.status, search: row.id }, message,
      querySelector: (selector) => selector === "[data-action-status]" ? message : null });
    card.remove = () => { ui.cards.splice(ui.cards.indexOf(card), 1); };
    card.statusSelect = element({ value: row.status, dataset: { feedbackId: row.id }, closest: () => card });
    card.deleteButton = element({ dataset: { feedbackId: row.id }, closest: () => card });
    card.githubButton = element({ dataset: { feedbackId: row.id }, closest: () => card,
      replaceWith: (link) => { card.githubLink = link; } });
    ui.cards.push(card);
  }
  ui.form = element({
    querySelector(selector) {
      return { "[data-import-file]": ui.file, "[data-import-status]": ui.importStatus,
        'button[type="submit"]': ui.submit, "[data-import-reload]": ui.reload }[selector] || null;
    }
  });
  ui.panel = rows.length ? element({
    querySelector(selector) {
      return { "[data-filter-text]": ui.search, "[data-filter-count]": ui.count }[selector] || null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-filter-key]");
      return [ui.statusFilter];
    }
  }) : null;
  const document = {
    querySelector(selector) {
      return {
        "[data-import-form]": ui.form,
        "[data-filter-panel]": ui.panel,
        "[data-total-count]": ui.total,
        "[data-filter-empty]": ui.filteredEmpty,
        "[data-inbox-empty]": ui.inboxEmpty,
        "[data-inbox-status]": ui.message
      }[selector] || null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-card]") return ui.cards.slice();
      if (selector === "[data-status-select]") return ui.cards.map((card) => card.statusSelect);
      if (selector === "[data-delete-feedback]") return ui.cards.map((card) => card.deleteButton);
      if (selector === "[data-github-create]") return ui.cards.map((card) => card.githubButton);
      if (selector === "[data-status-nav]") return ui.navigation;
      if (selector === "[data-filter-reset]") return [ui.reset];
      throw new Error(`Unexpected selector: ${selector}`);
    },
    createElement: () => element()
  };
  const replies = (options.replies || []).slice();
  vm.runInNewContext(script, {
    document, URL,
    window: {
      confirm: () => options.confirm !== false,
      alert: (message) => ui.alerts.push(message),
      location: { reload: () => { ui.reloads += 1; } }
    },
    fetch: async (url, requestOptions) => {
      ui.requests.push({ url, options: requestOptions });
      const reply = replies.shift() || { ok: true, body: {} };
      return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    }
  });
  return ui;
}
