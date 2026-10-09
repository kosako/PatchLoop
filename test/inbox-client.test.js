"use strict";

const assert = require("node:assert/strict");
const util = require("node:util");
const test = require("node:test");
const { script, renderInbox, parseDocument, inboxHarness } = require("../test-support/inbox-dom.js");

function feedback(id, extra = {}) {
  return { id, status: "new", comment: `Comment ${id}`, reviewer: "Reviewer", target: { kind: "point" }, page: {}, environment: {}, ...extra };
}

const visibleIds = (ui) => ui.all("[data-card]").filter((card) => !card.hidden)
  .map((card) => ui.get("[data-status-select]", card).dataset.feedbackId);

// Nodes never go into an assertion's actual / expected: a failing assertion
// renders both with util.inspect (deep, with getters), so identity is checked
// with === and reported as a short description instead.
const describe = (node) => node ? node.outerHTML.slice(0, 160) : String(node);
const assertSameNode = (actual, expected, label) =>
  assert.ok(actual === expected, `${label}: expected ${describe(expected)}, got ${describe(actual)}`);
const assertNoNode = (node, label) => assert.ok(node === null, `${label}: expected none, got ${describe(node)}`);

test("every hook inbox.js queries is rendered by the server's markup", () => {
  // Hooks behind ?. fail silently in a browser when the markup drops them, so
  // check each one the script looks up against the parsed page.
  const selectors = new Set([...script.matchAll(/(?:querySelector(?:All)?|closest)\((["'])(.+?)\1\)/g)].map((match) => match[2]));
  for (const hook of ["[data-filter-key]", "[data-status-count]", "[data-github-create]", "[data-github-cell]", "#inbox"]) assert.ok(selectors.has(hook), hook);
  const ui = inboxHarness([feedback("one", { integrations: { github: { status: "failed", error: "boom" } } })]);
  for (const selector of selectors) assert.ok(ui.document.querySelector(selector), `${selector} is missing from the rendered inbox`);
  // Each filter compares its value with the card attribute of the same key.
  for (const select of ui.all("[data-filter-key]")) {
    assert.notEqual(ui.card("one").dataset[select.dataset.filterKey], undefined, `cards lack data-${select.dataset.filterKey}`);
  }
});

test("status success reapplies the selected filter and updates the visible count", async () => {
  const ui = inboxHarness([feedback("one"), feedback("two", { status: "fixed" })]);
  await ui.change(ui.get('[data-filter-key="status"]'), "new");
  assert.equal(ui.get("[data-filter-count]").textContent, "1 / 2 件");
  const card = ui.card("one");
  const select = ui.get("[data-status-select]", card);
  const update = ui.change(select, "fixed");
  assert.equal(select.disabled, true);
  await update;
  assert.equal(card.dataset.status, "fixed");
  assert.equal(card.hidden, true);
  assert.equal(select.disabled, false);
  assert.equal(ui.get("[data-filter-count]").textContent, "0 / 2 件");
  assert.equal(ui.get("[data-total-count]").textContent, "2");
  assert.equal(ui.get("[data-filter-empty]").hidden, false);
  assert.equal(ui.get("[data-inbox-empty]").hidden, true);
  assert.deepEqual(JSON.parse(ui.requests[0].options.body), { status: "fixed" });
});

test("a rejected status edit restores the selection and preserves the list", async () => {
  const ui = inboxHarness([feedback("one")], { replies: [{ ok: false, body: { error: "Status rejected" } }] });
  await ui.change(ui.get('[data-filter-key="status"]'), "new");
  const card = ui.card("one");
  const select = ui.get("[data-status-select]", card);
  await ui.change(select, "fixed");
  assert.equal(card.dataset.status, "new");
  assert.equal(select.value, "new");
  assert.equal(select.disabled, false);
  assert.equal(card.hidden, false);
  assert.equal(ui.get("[data-filter-count]").textContent, "1 件");
  assert.equal(ui.get("[data-action-status]", card).textContent, "Status rejected");
  assert.equal(ui.get("[data-action-status]", card).dataset.state, "error");
  assert.deepEqual(ui.alerts, []);
});

test("deletion counts the live cards and distinguishes no matches from an empty inbox", async () => {
  const ui = inboxHarness([feedback("one"), feedback("two", { status: "fixed" })]);
  const panel = ui.get("[data-filter-panel]");
  await ui.change(ui.get('[data-filter-key="status"]'), "new");
  await ui.click(ui.get("[data-delete-feedback]", ui.card("one")));
  assert.equal(ui.all("[data-card]").length, 1);
  assert.equal(ui.get("[data-total-count]").textContent, "1");
  assert.equal(ui.get("[data-filter-count]").textContent, "0 / 1 件");
  assert.equal(ui.get("[data-filter-empty]").hidden, false);
  assert.equal(ui.get("[data-inbox-empty]").hidden, true);
  assert.equal(panel.hidden, false);
  assert.equal(ui.get("[data-inbox-status]").textContent, "フィードバックを削除しました。");
  assertSameNode(ui.document.activeElement, ui.get("[data-filter-text]"), "focus");

  await ui.change(ui.get('[data-filter-key="status"]'), "");
  assert.equal(ui.get("[data-filter-count]").textContent, "1 件");
  await ui.click(ui.get("[data-delete-feedback]", ui.card("two")));
  assert.equal(ui.all("[data-card]").length, 0);
  assert.equal(ui.get("[data-total-count]").textContent, "0");
  assert.equal(ui.get("[data-filter-count]").textContent, "0 件");
  assert.equal(ui.get("[data-inbox-empty]").hidden, false);
  assert.equal(ui.get("[data-filter-empty]").hidden, true);
  assert.equal(panel.hidden, true);
  // With the filters hidden, focus moves to the list itself.
  assertSameNode(ui.document.activeElement, ui.get("#inbox"), "focus");
});

test("a failed or cancelled deletion preserves cards and counts", async () => {
  const failed = inboxHarness([feedback("one")], { replies: [{ ok: false, body: { error: "Deletion rejected" } }] });
  const card = failed.card("one");
  const button = failed.get("[data-delete-feedback]", card);
  await failed.click(button);
  assert.equal(failed.all("[data-card]").length, 1);
  assert.equal(failed.get("[data-total-count]").textContent, "1");
  assert.equal(failed.get("[data-filter-count]").textContent, "1 件");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "削除");
  assert.equal(failed.get("[data-action-status]", card).textContent, "Deletion rejected");
  assert.equal(failed.get("[data-action-status]", card).dataset.state, "error");
  assert.deepEqual(failed.alerts, []);

  const cancelled = inboxHarness([feedback("one")], { confirm: false });
  await cancelled.click(cancelled.get("[data-delete-feedback]", cancelled.card("one")));
  assert.equal(cancelled.requests.length, 0);
  assert.equal(cancelled.all("[data-card]").length, 1);
  assert.equal(cancelled.get("[data-total-count]").textContent, "1");
});

test("text search continues to use the remaining cards after a deletion", async () => {
  const ui = inboxHarness([feedback("alpha"), feedback("beta")]);
  const search = ui.get("[data-filter-text]");
  await ui.click(ui.get("[data-delete-feedback]", ui.card("alpha")));
  await ui.input(search, " ALPHA ");
  assert.equal(ui.get("[data-filter-count]").textContent, "0 / 1 件");
  assert.equal(ui.get("[data-filter-empty]").hidden, false);
  await ui.input(search, "BETA");
  assert.equal(ui.get("[data-filter-count]").textContent, "1 件");
  assert.equal(ui.get("[data-filter-empty]").hidden, true);
});

test("an initially empty inbox does not require a filter panel", () => {
  const ui = inboxHarness([]);
  assertNoNode(ui.document.querySelector("[data-filter-panel]"), "filter panel");
  assert.equal(ui.get("[data-total-count]").textContent, "0");
  assert.equal(ui.get("[data-inbox-empty]").hidden, false);
  assert.equal(ui.get("[data-filter-empty]").hidden, true);
});

test("import reports missing files, duplicate results, and failed requests", async () => {
  const missing = inboxHarness([]);
  await missing.submit(missing.get("[data-import-form]"));
  assert.equal(missing.get("[data-import-status]").dataset.state, "error");
  assert.equal(missing.requests.length, 0);

  const duplicate = inboxHarness([], { replies: [{ ok: false, body: { imported: 0, duplicates: ["existing"], failed: [] } }] });
  duplicate.get("[data-import-file]").files = [{ text: async () => "{}" }];
  await duplicate.submit(duplicate.get("[data-import-form]"));
  assert.match(duplicate.get("[data-import-status]").textContent, /重複 1 件はスキップ/);
  assert.equal(duplicate.reloads, 0);

  const failed = inboxHarness([], { replies: [{ ok: false, body: { error: "Import rejected" } }] });
  failed.get("[data-import-file]").files = [{ text: async () => "{}" }];
  await failed.submit(failed.get("[data-import-form]"));
  assert.equal(failed.get("[data-import-status]").textContent, "Import rejected");
  assert.equal(failed.get("[data-import-status]").dataset.state, "error");
});

test("sidebar counts follow triage changes and reset restores search and status", async () => {
  const ui = inboxHarness([feedback("alpha"), feedback("beta", { status: "fixed" })]);
  const badge = (status) => ui.get("[data-status-count]", ui.get(`[data-status-nav="${status}"]`));
  await ui.click(ui.get('[data-status-nav="new"]'));
  assert.equal(ui.get('[data-filter-key="status"]').value, "new");
  assert.equal(ui.get('[data-status-nav="new"]').getAttribute("aria-pressed"), "true");
  await ui.input(ui.get("[data-filter-text]"), "missing");
  assert.equal(badge("").textContent, "2");
  await ui.click(ui.get("[data-filter-reset]", ui.get("[data-filter-panel]")));
  assert.equal(ui.get("[data-filter-count]").textContent, "2 件");
  assertSameNode(ui.document.activeElement, ui.get("[data-filter-text]"), "focus");
  await ui.change(ui.get("[data-status-select]", ui.card("alpha")), "fixed");
  assert.equal(badge("new").textContent, "0");
  assert.equal(badge("fixed").textContent, "2");
});

test("status badges count every card by its rendered status, whatever the filters", async () => {
  const items = [feedback("a"), feedback("b"), feedback("c", { status: "fixed" }), feedback("d", { status: "unknown-status" }), feedback("e", { status: "accepted" })];
  const expected = { "": "5", new: "3", accepted: "1", fixed: "1", ignored: "0" };
  const server = parseDocument(renderInbox(items));
  const ui = inboxHarness(items);
  const badges = (page) => Object.fromEntries(page.querySelectorAll("[data-status-count]").map((badge) => [badge.dataset.statusCount, badge.textContent]));
  assert.deepEqual(badges(server), expected);
  assert.deepEqual(badges(ui.document), expected);
  await ui.input(ui.get("[data-filter-text]"), "comment a");
  await ui.change(ui.get('[data-filter-key="kind"]'), "area");
  assert.equal(ui.get("[data-filter-count]").textContent, "0 / 5 件");
  assert.deepEqual(badges(ui.document), expected);
});

test("detail filters combine with each other on the rendered card attributes", async () => {
  const sent = { slack: { status: "sent" } };
  const ui = inboxHarness([
    feedback("a", { target: { kind: "area" }, demoId: "d1", reviewer: "Aki", integrations: { ...sent } }),
    feedback("b", { target: { kind: "area" }, demoId: "d1", reviewer: "Aki", integrations: { slack: { status: "failed" } } }),
    feedback("c", { target: { kind: "area" }, demoId: "d2", reviewer: "Aki", integrations: { ...sent } }),
    feedback("d", { target: { kind: "point" }, demoId: "d1", reviewer: "Aki", integrations: { ...sent } }),
    feedback("e", { target: { kind: "area" }, demoId: "d1", reviewer: "Ben", integrations: { ...sent, github: { status: "failed", error: "boom" } } })
  ]);
  const filter = (key) => ui.get(`[data-filter-key="${key}"]`);
  await ui.change(filter("kind"), "area");
  assert.deepEqual(visibleIds(ui), ["a", "b", "c", "e"]);
  await ui.change(filter("demo"), "d1");
  assert.deepEqual(visibleIds(ui), ["a", "b", "e"]);
  await ui.change(filter("reviewer"), "Aki");
  assert.deepEqual(visibleIds(ui), ["a", "b"]);
  await ui.change(filter("slack"), "sent");
  assert.deepEqual(visibleIds(ui), ["a"]);
  assert.equal(ui.get("[data-filter-count]").textContent, "1 / 5 件");
  await ui.change(filter("github"), "failed");
  assert.deepEqual(visibleIds(ui), []);
  assert.equal(ui.get("[data-filter-empty]").hidden, false);

  await ui.click(ui.get("[data-filter-reset]", ui.get("[data-filter-empty]")));
  assert.deepEqual(visibleIds(ui), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ui.all("[data-filter-key]").map((select) => select.value), Array(8).fill(""));
  assert.equal(ui.get("[data-filter-count]").textContent, "5 件");
});

test("partial import stays visible and blocks a concurrent submission", async () => {
  const ui = inboxHarness([], { replies: [{ ok: true, body: { imported: 1, duplicates: ["one"], failed: [{ error: "invalid" }] } }] });
  const form = ui.get("[data-import-form]");
  const submit = ui.get('button[type="submit"]', form);
  let finishReading;
  ui.get("[data-import-file]").files = [{ text: () => new Promise((resolve) => { finishReading = resolve; }) }];
  const first = ui.submit(form);
  assert.equal(submit.disabled, true);
  await ui.submit(form);
  finishReading("{}");
  await first;
  assert.equal(ui.requests.length, 1);
  assert.match(ui.get("[data-import-status]").textContent, /1 件を追加.*重複 1 件.*失敗 1 件/);
  assert.equal(ui.get("[data-import-status]").dataset.state, "error");
  assert.equal(ui.get("[data-import-reload]").hidden, false);
  assert.equal(submit.disabled, false);
  assert.equal(ui.reloads, 0);
  await ui.click(ui.get("[data-import-reload]"));
  assert.equal(ui.reloads, 1);
});

test("expired sessions and throttling preserve the user's filter and selection", async () => {
  for (const [status, expected] of [[401, /ログイン/], [429, /しばらく待って/]]) {
    const ui = inboxHarness([feedback("one")], { replies: [{ ok: false, status, body: {} }] });
    const card = ui.card("one");
    await ui.input(ui.get("[data-filter-text]"), "one");
    await ui.change(ui.get("[data-status-select]", card), "fixed");
    assert.equal(ui.get("[data-filter-text]").value, "one");
    assert.equal(ui.get("[data-status-select]", card).value, "new");
    assert.match(ui.get("[data-action-status]", card).textContent, expected);
  }
});

test("GitHub creation and existing-issue recovery replace the action with a safe link", async () => {
  for (const status of [201, 409]) {
    const ui = inboxHarness([feedback("one")], { replies: [{ ok: status === 201, status,
      body: { github: { issueNumber: 42, url: "https://github.com/example/demo/issues/42" } } }] });
    const card = ui.card("one");
    await ui.click(ui.get("[data-github-create]", card));
    const link = ui.get("a", ui.get("[data-github-cell]", card));
    assert.equal(link.href, "https://github.com/example/demo/issues/42");
    assertSameNode(ui.document.activeElement, link, "focus");
    assert.equal(card.dataset.github, "created");
    assert.equal(ui.reloads, 0);
  }
});

test("re-creating an issue on a previously failed card leaves the cell as the server renders a created issue", async () => {
  const github = { status: "created", issueNumber: 42, url: "https://github.com/example/demo/issues/42" };
  const server = parseDocument(renderInbox([feedback("one", { integrations: { github } })]));
  for (const status of [201, 409]) {
    const ui = inboxHarness([feedback("one", { integrations: { github: { status: "failed", statusCode: 500, error: "Server error" } } })],
      { replies: [{ ok: status === 201, status, body: { github } }] });
    const card = ui.card("one");
    const cell = ui.get("[data-github-cell]", card);
    assert.ok(cell.querySelector(".github-error"));
    await ui.click(ui.get("[data-github-create]", card));
    assertNoNode(cell.querySelector(".github-error"), "failure note");
    assert.equal(cell.outerHTML, server.querySelector("[data-github-cell]").outerHTML);
    assert.equal(card.dataset.github, server.querySelector("[data-card]").dataset.github);
    assertSameNode(ui.document.activeElement, ui.get("a", cell), "focus");
  }
});

test("a failed GitHub issue creation restores the button and reports on the card", async () => {
  const ui = inboxHarness([feedback("one")], { replies: [{ ok: false, status: 502, body: { error: "GitHub is unavailable" } }] });
  const card = ui.card("one");
  const button = ui.get("[data-github-create]", card);
  const creation = ui.click(button);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "作成中…");
  await ui.click(button);
  await creation;
  assert.equal(ui.requests.length, 1);
  assertSameNode(ui.get("[data-github-create]", card), button, "create button");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "GitHub Issue を作成");
  assertNoNode(ui.get("[data-github-cell]", card).querySelector("a"), "issue link");
  assert.notEqual(card.dataset.github, "created");
  const message = ui.get("[data-action-status]", card);
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, "GitHub is unavailable");
  assert.equal(message.dataset.state, "error");
  assert.equal(ui.get("[data-inbox-status]").hidden, true);
});

test("an invalid created-issue URL never enables duplicate creation or an unsafe link", async () => {
  for (const github of [undefined, { status: "failed", statusCode: 500, error: "Server error" }]) {
    const ui = inboxHarness([feedback("one", { integrations: { github } })], { replies: [{ ok: true,
      body: { github: { issueNumber: 42, url: "javascript:alert(1)" } } }] });
    const card = ui.card("one");
    const button = ui.get("[data-github-create]", card);
    await ui.click(button);
    const cell = ui.get("[data-github-cell]", card);
    assertNoNode(cell.querySelector("a"), "issue link");
    assertSameNode(ui.get("[data-github-create]", card), button, "create button");
    assert.equal(button.disabled, true);
    // The issue exists, so an earlier failure is no longer shown beside it.
    assertNoNode(cell.querySelector(".github-error"), "failure note");
    assert.match(ui.get("[data-action-status]", card).textContent, /ページを更新/);
  }
});

test("results for a card the filters now hide are reported in the inbox status", async () => {
  const triage = inboxHarness([feedback("one"), feedback("two")]);
  await triage.change(triage.get('[data-filter-key="status"]'), "new");
  const triaged = triage.card("one");
  await triage.change(triage.get("[data-status-select]", triaged), "fixed");
  assert.equal(triaged.hidden, true);
  assert.equal(triage.get("[data-action-status]", triaged).hidden, true);
  assert.equal(triage.get("[data-inbox-status]").hidden, false);
  assert.equal(triage.get("[data-inbox-status]").textContent, "対応状況を更新しました。");
  assert.equal(triage.get("[data-inbox-status]").dataset.state, "success");
  assertSameNode(triage.document.activeElement, triage.get("[data-filter-text]"), "focus");

  const github = inboxHarness([feedback("one"), feedback("two")], { replies: [{ ok: true, status: 201,
    body: { github: { status: "created", issueNumber: 42, url: "https://github.com/example/demo/issues/42" } } }] });
  await github.change(github.get('[data-filter-key="github"]'), "none");
  const created = github.card("one");
  await github.click(github.get("[data-github-create]", created));
  assert.equal(created.hidden, true);
  assert.equal(github.get("[data-filter-count]").textContent, "1 / 2 件");
  assert.equal(github.get("[data-action-status]", created).hidden, true);
  assert.equal(github.get("[data-inbox-status]").hidden, false);
  assert.equal(github.get("[data-inbox-status]").textContent, "GitHub Issue を作成しました。");
  assert.equal(github.get("[data-inbox-status]").dataset.state, "success");
  assertSameNode(github.document.activeElement, github.get("[data-filter-text]"), "focus");
});

test("a node renders the same at any depth, so a failing assertion cannot walk the page", () => {
  // A failing assertion renders its values with util.inspect, deep and with
  // getters. Tree links must stay non-enumerable: a node that exposes them
  // reaches the whole page through every path between nodes, which once ran a
  // test process past 80 GB outside the V8 heap. Rendering deeper must add
  // nothing, and checking that at shallow depths stays cheap if links leak.
  const ui = inboxHarness([feedback("one"), feedback("two")]);
  for (const node of [ui.get("[data-filter-text]"), ui.card("one"), ui.document.body]) {
    const rendered = (depth) => util.inspect(node, { depth, getters: true, compact: false, customInspect: false }).length;
    assert.ok(rendered(4) === rendered(2), `${node.tagName} grows from ${rendered(2)} to ${rendered(4)} chars between depth 2 and 4`);
  }
});
