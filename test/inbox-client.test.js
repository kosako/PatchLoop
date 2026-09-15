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
  assert.deepEqual(ui.alerts, ["Status rejected"]);
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
  assert.deepEqual(failed.alerts, ["Deletion rejected"]);

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
  assert.match(duplicate.importStatus.textContent, /1 duplicate skipped/);
  assert.equal(duplicate.reloads, 0);

  const failed = createInbox([], { replies: [{ ok: false, body: { error: "Import rejected" } }] });
  failed.file.files = [{ text: async () => "{}" }];
  await failed.form.fire("submit");
  assert.equal(failed.importStatus.textContent, "Import rejected");
  assert.equal(failed.importStatus.dataset.state, "error");
});

function element(properties = {}) {
  const listeners = new Map();
  return {
    dataset: {}, value: "", hidden: false, disabled: false, textContent: "",
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
    statusFilter: element({ dataset: { filterKey: "status" } })
  };
  for (const row of rows) {
    const card = element({ dataset: { status: row.status, search: row.id } });
    card.remove = () => { ui.cards.splice(ui.cards.indexOf(card), 1); };
    card.statusSelect = element({ value: row.status, dataset: { feedbackId: row.id }, closest: () => card });
    card.deleteButton = element({ dataset: { feedbackId: row.id }, closest: () => card });
    ui.cards.push(card);
  }
  ui.form = element({
    querySelector(selector) {
      return { "[data-import-file]": ui.file, "[data-import-status]": ui.importStatus }[selector] || null;
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
        "[data-inbox-empty]": ui.inboxEmpty
      }[selector] || null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-card]") return ui.cards.slice();
      if (selector === "[data-status-select]") return ui.cards.map((card) => card.statusSelect);
      if (selector === "[data-delete-feedback]") return ui.cards.map((card) => card.deleteButton);
      if (selector === "[data-github-create]") return [];
      throw new Error(`Unexpected selector: ${selector}`);
    }
  };
  const replies = (options.replies || []).slice();
  vm.runInNewContext(script, {
    document,
    window: {
      confirm: () => options.confirm !== false,
      alert: (message) => ui.alerts.push(message),
      location: { reload: () => { ui.reloads += 1; } }
    },
    fetch: async (url, requestOptions) => {
      ui.requests.push({ url, options: requestOptions });
      const reply = replies.shift() || { ok: true, body: {} };
      return { ok: reply.ok, json: async () => reply.body };
    }
  });
  return ui;
}
