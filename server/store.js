"use strict";

// Feedback persistence, isolated behind a small async interface so the
// backend can be swapped (sqlite now, a remote DB like MySQL later) without
// touching the receiver. The receiver only ever calls the methods documented
// in the Store contract below.
//
// Store contract (all methods async so a network-backed driver can implement
// the same shape):
//   init()                         prepare storage; migrate a legacy JSON store once
//   insert(item)                   persist a new feedback object
//   get(id)            -> item|null
//   list({projectId, demoId, status}) -> item[]   newest first; filters are optional
//   update(id, patch)  -> item|null shallow-merge patch into the stored item
//   delete(id)         -> item|null returns the removed item (for screenshot cleanup)
//   count()            -> number
//   close()
//
// A new backend (e.g. createMysqlStore) just needs to implement this shape and
// be wired into createStore() below; the receiver code stays unchanged.

const fs = require("fs");
const path = require("path");

// node:sqlite is still flagged experimental and prints a warning when it
// loads. Swallow only that one line, and restore the original handler right
// after the require so the override does not stay in effect process-wide.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === "string" ? warning : warning && warning.message;
  if (text && text.includes("SQLite is an experimental feature")) return;
  return originalEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = originalEmitWarning;

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(error && error.message);
}

const VALID_STATUSES = ["new", "accepted", "fixed", "ignored"];

function normalizeStatus(value) {
  return VALID_STATUSES.includes(value) ? value : "new";
}

// Columns extracted from each feedback object for indexed filtering. The full
// object always round-trips through the JSON `data` column, so adding fields to
// the payload never needs a schema change — only new filterable fields do.
function extractColumns(item) {
  return {
    id: String(item.id),
    project_id: item.projectId == null ? null : String(item.projectId),
    demo_id: item.demoId == null ? null : String(item.demoId),
    status: normalizeStatus(item.status),
    received_at: item.receivedAt == null ? null : String(item.receivedAt)
  };
}

function createSqliteStore({ dbPath, legacyJsonPath }) {
  let db;

  function migrateLegacyJson() {
    if (!legacyJsonPath || !fs.existsSync(legacyJsonPath)) return;

    let items;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyJsonPath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("legacy store is not an array");
      items = parsed;
    } catch (error) {
      // Never discard an unreadable store silently: set it aside so a human
      // can recover it, then start from an empty database.
      const backup = `${legacyJsonPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(legacyJsonPath, backup);
        console.warn(`[PatchLoop store] legacy feedback.json corrupt (${error.message}); backed up to ${backup}`);
      } catch (backupError) {
        console.warn(`[PatchLoop store] legacy feedback.json corrupt and backup failed: ${backupError.message}`);
      }
      return;
    }

    // All-or-nothing: a migration interrupted partway would leave rows behind,
    // and the next startup (seeing a non-empty table) would skip migration and
    // strand the remaining legacy items. A transaction rolls back on failure so
    // the legacy file stays intact and the next startup retries.
    db.exec("BEGIN");
    try {
      // The JSON array is newest-first; insert oldest-first so seq order (and
      // therefore newest-first reads) matches what the array represented.
      // OR IGNORE keeps the first of any duplicate legacy ids instead of
      // aborting the whole migration.
      for (const item of items.slice().reverse()) {
        if (item && item.id != null) insertRow(item, { ignoreConflict: true });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const archived = `${legacyJsonPath}.migrated-${Date.now()}`;
    try {
      fs.renameSync(legacyJsonPath, archived);
      console.log(`[PatchLoop store] migrated ${items.length} feedback item(s) from ${legacyJsonPath} -> sqlite (archived to ${archived})`);
    } catch (error) {
      console.warn(`[PatchLoop store] migrated legacy store but could not archive it: ${error.message}`);
    }
  }

  function insertRow(item, { ignoreConflict = false } = {}) {
    const cols = extractColumns(item);
    const verb = ignoreConflict ? "INSERT OR IGNORE" : "INSERT";
    db.prepare(
      `${verb} INTO feedback (id, project_id, demo_id, status, received_at, data) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(cols.id, cols.project_id, cols.demo_id, cols.status, cols.received_at, JSON.stringify(item));
  }

  return {
    async init() {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT UNIQUE NOT NULL,
          project_id TEXT,
          demo_id TEXT,
          status TEXT,
          received_at TEXT,
          data TEXT NOT NULL
        )
      `);
      const existing = db.prepare("SELECT COUNT(*) AS n FROM feedback").get().n;
      if (existing === 0) migrateLegacyJson();
    },

    async insert(item) {
      // A duplicate id is anomalous (ids are unique by construction). Reject it
      // with a 409 instead of silently overwriting the existing row (data loss)
      // or silently appending a second row that breaks id-based triage.
      try {
        insertRow(item);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const conflict = new Error(`feedback id already exists: ${item.id}`);
          conflict.statusCode = 409;
          throw conflict;
        }
        throw error;
      }
    },

    async get(id) {
      const row = db.prepare("SELECT data FROM feedback WHERE id = ?").get(String(id));
      return row ? JSON.parse(row.data) : null;
    },

    async list(filter = {}) {
      const clauses = [];
      const params = [];
      if (filter.projectId != null) {
        clauses.push("project_id = ?");
        params.push(String(filter.projectId));
      }
      if (filter.demoId != null) {
        clauses.push("demo_id = ?");
        params.push(String(filter.demoId));
      }
      if (filter.status != null) {
        clauses.push("status = ?");
        params.push(String(filter.status));
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT data FROM feedback${where} ORDER BY seq DESC`).all(...params);
      return rows.map((row) => JSON.parse(row.data));
    },

    // Read and write happen without an await in between, so the whole
    // read-modify-write runs synchronously on the single thread and cannot lose
    // a concurrent update. A networked backend would wrap this in a transaction.
    async update(id, patch) {
      const row = db.prepare("SELECT data FROM feedback WHERE id = ?").get(String(id));
      if (!row) return null;
      const updated = { ...JSON.parse(row.data), ...patch };
      const cols = extractColumns(updated);
      db.prepare(
        "UPDATE feedback SET project_id = ?, demo_id = ?, status = ?, received_at = ?, data = ? WHERE id = ?"
      ).run(cols.project_id, cols.demo_id, cols.status, cols.received_at, JSON.stringify(updated), String(id));
      return updated;
    },

    async delete(id) {
      const row = db.prepare("SELECT data FROM feedback WHERE id = ?").get(String(id));
      if (!row) return null;
      db.prepare("DELETE FROM feedback WHERE id = ?").run(String(id));
      return JSON.parse(row.data);
    },

    async count() {
      return db.prepare("SELECT COUNT(*) AS n FROM feedback").get().n;
    },

    async close() {
      if (db) db.close();
    }
  };
}

function createStore(config = {}) {
  const backend = config.backend || "sqlite";
  if (backend === "sqlite") {
    return createSqliteStore(config);
  }
  // Future backends (e.g. "mysql") implement the same Store contract and are
  // wired in here; the receiver does not change.
  throw new Error(`Unknown store backend: ${backend}`);
}

module.exports = { createStore };
