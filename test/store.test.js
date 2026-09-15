"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createStore } = require("../server/store");
const { DatabaseSync } = require("node:sqlite");

test("provider updates preserve the latest status and other provider results in either order", async (t) => {
  const fixture = createFixture(t);
  const store = await fixture.open();
  for (const providers of [["slack", "github"], ["github", "slack"]]) {
    const id = providers.join("-");
    const original = {
      id,
      status: "new",
      projectId: "project-a",
      comment: "Keep the original feedback",
      integrations: { other: { status: "sent" } }
    };
    await store.insert(original);
    // Simulate responses arriving after the initial feedback was read, with
    // a status edit between the provider completions.
    await store.get(id);
    await store.updateIntegration(id, providers[0], { status: "sent", attempt: 1 });
    await store.update(id, { status: "accepted" });
    const updated = await store.updateIntegration(id, providers[1], { status: "sent", attempt: 2 });
    assert.deepEqual(updated, {
      ...original,
      status: "accepted",
      integrations: {
        other: { status: "sent" },
        [providers[0]]: { status: "sent", attempt: 1 },
        [providers[1]]: { status: "sent", attempt: 2 }
      }
    });
    assert.deepEqual(await store.get(id), updated);
    assert.ok((await store.list({ status: "accepted" })).some((item) => item.id === id));
    await store.updateIntegration(id, providers[0], { status: "failed" });
    assert.deepEqual((await store.get(id)).integrations[providers[0]], { status: "failed" });
  }
  assert.equal(await store.updateIntegration("missing", "slack", { status: "sent" }), null);
});

test("provider updates initialize absent integration metadata", async (t) => {
  const fixture = createFixture(t);
  const store = await fixture.open();
  await store.insert({ id: "no-integrations", status: "new" });
  const result = await store.updateIntegration("no-integrations", "github", { status: "created", number: 12 });
  assert.deepEqual(result.integrations, { github: { status: "created", number: 12 } });
});

test("legacy archive failure cannot resurrect deleted feedback after restart", async (t) => {
  const fixture = createFixture(t);
  fixture.writeLegacy([{ id: "legacy", status: "new" }]);
  preventArchive(t);
  const store = await fixture.open();
  assert.equal(await store.count(), 1);
  assert.equal(fs.existsSync(fixture.legacyJsonPath), true);
  await store.delete("legacy");
  await fixture.close(store);

  const restarted = await fixture.open();
  assert.equal(await restarted.count(), 0);
});

test("an empty legacy array also completes migration despite archive failure", async (t) => {
  const fixture = createFixture(t);
  fixture.writeLegacy([]);
  preventArchive(t);
  const store = await fixture.open();
  assert.equal(await store.count(), 0);
  await fixture.close(store);
  // A changed file is not a new automatic import once migration completed.
  fixture.writeLegacy([{ id: "must-not-import" }]);
  const restarted = await fixture.open();
  assert.equal(await restarted.count(), 0);
});

test("upgrading a non-empty database preserves rows and permanently skips legacy import", async (t) => {
  const fixture = createFixture(t);
  const original = { id: "existing", status: "fixed", integrations: { github: { number: 7 } } };
  const db = new DatabaseSync(fixture.dbPath);
  try {
    // Previous schema: no migration metadata table exists.
    db.exec(`CREATE TABLE feedback (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      project_id TEXT, demo_id TEXT, status TEXT, received_at TEXT, data TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO feedback (id, status, data) VALUES (?, ?, ?)")
      .run(original.id, original.status, JSON.stringify(original));
  } finally {
    db.close();
  }
  fixture.writeLegacy([{ id: "stale-legacy" }]);
  const store = await fixture.open();
  assert.deepEqual(await store.list(), [original]);
  await store.delete(original.id);
  await fixture.close(store);
  const restarted = await fixture.open();
  assert.equal(await restarted.count(), 0);
  assert.equal(fs.existsSync(fixture.legacyJsonPath), true);
});

test("an empty database with no legacy file can migrate a file added later", async (t) => {
  const fixture = createFixture(t);
  const store = await fixture.open();
  await fixture.close(store);
  fixture.writeLegacy([{ id: "added-later" }]);
  const restarted = await fixture.open();
  assert.deepEqual((await restarted.list()).map((item) => item.id), ["added-later"]);
});

test("failed legacy insertion rolls back every row and leaves migration retryable", async (t) => {
  const fixture = createFixture(t);
  const initial = await fixture.open();
  await fixture.close(initial);
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.exec(`CREATE TRIGGER reject_legacy BEFORE INSERT ON feedback
      WHEN NEW.id = 'reject' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  } finally {
    db.close();
  }
  // Oldest-first insertion writes 'inserted-first' before the failing row.
  fixture.writeLegacy([{ id: "reject" }, { id: "inserted-first" }]);
  const failed = createStore(fixture.config);
  try {
    await assert.rejects(failed.init(), /injected migration failure/);
    assert.equal(await failed.count(), 0);
    assert.equal(fs.existsSync(fixture.legacyJsonPath), true);
  } finally {
    await failed.close();
  }
  const repair = new DatabaseSync(fixture.dbPath);
  try {
    assert.equal(repair.prepare("SELECT COUNT(*) AS n FROM store_metadata").get().n, 0);
    repair.exec("DROP TRIGGER reject_legacy");
  } finally {
    repair.close();
  }
  const retried = await fixture.open();
  assert.deepEqual((await retried.list()).map((item) => item.id), ["reject", "inserted-first"]);
});

function preventArchive(t) {
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("injected archive failure"), { code: "EACCES" });
  });
}

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "patchloop-store-test-"));
  const config = {
    dbPath: path.join(directory, "feedback.db"),
    legacyJsonPath: path.join(directory, "feedback.json")
  };
  const openStores = new Set();
  t.after(async () => {
    for (const store of openStores) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...config,
    config,
    writeLegacy(items) {
      fs.writeFileSync(config.legacyJsonPath, JSON.stringify(items));
    },
    async open() {
      const store = createStore(config);
      openStores.add(store);
      await store.init();
      return store;
    },
    async close(store) {
      await store.close();
      openStores.delete(store);
    }
  };
}
