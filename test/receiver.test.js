"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const RECEIVER_PATH = path.resolve(__dirname, "../server/receive.js");

test("POST /feedback stores valid feedback and saves screenshot data URLs", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_feedback_1");

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.id, payload.id);
  assert.equal(response.body.count, 1);
  assert.deepEqual(response.body.slack, { status: "disabled" });

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, payload.id);
  assert.equal(stored[0].screenshot.status, "saved");
  assert.equal(stored[0].screenshot.mimeType, "image/svg+xml");
  assert.equal(stored[0].screenshot.bytes, Buffer.byteLength(testSvg()));
  assert.equal(stored[0].screenshot.dataUrl, undefined);

  const screenshotFile = await fs.readFile(stored[0].screenshot.path, "utf8");
  assert.equal(screenshotFile, testSvg());

  const screenshotResponse = await fetch(stored[0].screenshot.url);
  assert.equal(screenshotResponse.status, 200);
  assert.match(screenshotResponse.headers.get("content-type"), /^image\/svg\+xml/);
  assert.equal(await screenshotResponse.text(), testSvg());
});

test("POST /feedback rejects malformed feedback payloads", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_invalid_feedback");
  payload.reviewer = "";

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /feedback\.reviewer must not be empty/);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("POST /import stores bundle feedback and strips delivery metadata", async (t) => {
  const receiver = await startReceiver(t);
  const payload = {
    ...feedbackPayload("pl_import_1"),
    delivery: { ok: true, status: 201 },
    integrations: { slack: { status: "sent" } },
    receivedAt: "2026-06-01T00:00:00.000Z",
    importedAt: "2026-06-01T00:00:00.000Z",
    source: "receiver"
  };

  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 1,
    exportedAt: "2026-06-03T00:00:00.000Z",
    feedback: payload
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.id, payload.id);
  assert.equal(response.body.source, "import");

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, payload.id);
  assert.equal(stored[0].source, "import");
  assert.equal(stored[0].delivery, undefined);
  assert.deepEqual(stored[0].integrations, {
    slack: { status: "skipped", reason: "import" }
  });
  assert.match(stored[0].importedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stored[0].screenshot.status, "saved");
});

test("POST /import rejects unsupported bundle versions", async (t) => {
  const receiver = await startReceiver(t);

  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 999,
    feedback: feedbackPayload("pl_bad_version")
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /Unsupported PatchLoop bundle version: 999/);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("POST /import stores every feedback in a v2 batch bundle", async (t) => {
  const receiver = await startReceiver(t);

  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    exportedAt: "2026-06-03T00:00:00.000Z",
    projectId: "patchloop",
    demoId: "receiver-test",
    feedback: [
      { ...feedbackPayload("pl_batch_1"), exported: true, exportedAt: "2026-06-03T01:00:00.000Z" },
      feedbackPayload("pl_batch_2"),
      feedbackPayload("pl_batch_3")
    ]
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.imported, 3);
  assert.deepEqual(response.body.ids, ["pl_batch_1", "pl_batch_2", "pl_batch_3"]);
  assert.deepEqual(response.body.duplicates, []);
  assert.deepEqual(response.body.failed, []);
  assert.equal(response.body.count, 3);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 3);
  for (const item of stored) {
    assert.equal(item.source, "import");
    // Local-only export markers must not be persisted.
    assert.equal(item.exported, undefined);
    assert.equal(item.exportedAt, undefined);
    assert.equal(item.screenshot.status, "saved");
  }
});

test("POST /import skips duplicate ids in a batch but lands the rest", async (t) => {
  const receiver = await startReceiver(t);
  await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: [feedbackPayload("pl_dup_1")]
  });

  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: [feedbackPayload("pl_dup_1"), feedbackPayload("pl_dup_2")]
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.imported, 1);
  assert.deepEqual(response.body.ids, ["pl_dup_2"]);
  assert.deepEqual(response.body.duplicates, ["pl_dup_1"]);
  assert.equal(response.body.count, 2);

  // The duplicate did not orphan a screenshot: exactly two files for two rows.
  const stored = await readStoredFeedback(receiver.dbPath);
  const files = await fs.readdir(receiver.screenshotDir);
  assert.equal(stored.length, 2);
  assert.equal(files.length, 2);
});

test("POST /import rejects the whole batch when one payload is invalid", async (t) => {
  const receiver = await startReceiver(t);
  const bad = feedbackPayload("pl_bad_2");
  bad.reviewer = "";

  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: [feedbackPayload("pl_good_1"), bad]
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /feedback\.reviewer must not be empty/);
  // Nothing was written — validation runs before any insert.
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("POST /import rejects the whole batch when a later screenshot is invalid", async (t) => {
  const receiver = await startReceiver(t);
  const bad = feedbackPayload("pl_badshot_2");
  bad.screenshot = { status: "captured", kind: "viewport-svg", dataUrl: "data:text/plain;base64,Zm9v" };

  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: [feedbackPayload("pl_goodshot_1"), bad]
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /Unsupported screenshot mime type/);
  // The first (valid) item must not have landed before the bad one failed.
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
  const files = await fs.readdir(receiver.screenshotDir).catch(() => []);
  assert.equal(files.length, 0);
});

test("POST /import enforces the feedback shape per bundle version", async (t) => {
  const receiver = await startReceiver(t);

  const v1Array = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 1,
    feedback: [feedbackPayload("pl_shape_1")]
  });
  assert.equal(v1Array.status, 400);
  assert.match(v1Array.body.error, /version 1 expects a single feedback object/);

  const v2Single = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: feedbackPayload("pl_shape_2")
  });
  assert.equal(v2Single.status, 400);
  assert.match(v2Single.body.error, /version 2 expects a feedback array/);

  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("POST /feedback/:id/status updates triage status and persists it", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_status_1");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const response = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, id: payload.id, status: "accepted" });

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].status, "accepted");
  assert.match(stored[0].statusUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("POST /feedback/:id/github-issue creates an issue via the GitHub API", async (t) => {
  const github = await startMockGitHub(t, (res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ number: 7, html_url: "https://github.com/acme/demo/issues/7" }));
  });
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPO: "acme/demo",
    GITHUB_LABELS: "feedback, patchloop",
    GITHUB_ASSIGNEES: "kosako",
    GITHUB_API_BASE: github.baseUrl
  });
  const payload = feedbackPayload("pl_github_1");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const response = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});

  assert.equal(response.status, 201);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.github.issueNumber, 7);
  assert.equal(response.body.github.url, "https://github.com/acme/demo/issues/7");

  const request = github.requests[0];
  assert.equal(request.url, "/repos/acme/demo/issues");
  assert.equal(request.headers.authorization, "Bearer test-token");
  assert.match(request.body.title, /^\[PatchLoop\] Move this button above the fold\./);
  assert.match(request.body.body, /## Feedback/);
  assert.match(request.body.body, /Test Reviewer/);
  assert.match(request.body.body, /#hero button/);
  assert.match(request.body.body, /screenshots\//);
  assert.deepEqual(request.body.labels, ["feedback", "patchloop"]);
  assert.deepEqual(request.body.assignees, ["kosako"]);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].integrations.github.status, "created");
  assert.equal(stored[0].integrations.github.issueNumber, 7);

  const again = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
  assert.equal(again.status, 409);
  assert.equal(github.requests.length, 1);
});

test("POST /feedback/:id/github-issue serializes concurrent requests (no duplicate issue)", async (t) => {
  // Respond slowly so both requests overlap on the server: the first holds the
  // in-flight marker while the second arrives.
  const github = await startMockGitHub(t, (res) => {
    setTimeout(() => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ number: 7, html_url: "https://github.com/acme/demo/issues/7" }));
    }, 60);
  });
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPO: "acme/demo",
    GITHUB_API_BASE: github.baseUrl
  });
  const payload = feedbackPayload("pl_github_concurrent");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const [a, b] = await Promise.all([
    postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {}),
    postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {})
  ]);

  // Exactly one creates the issue (201); the other is rejected (409). Only one
  // request reaches the GitHub API, so no duplicate issue is opened.
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(github.requests.length, 1);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].integrations.github.status, "created");
});

test("POST /feedback/:id/github-issue persists failures and requires configuration", async (t) => {
  const unconfigured = await startReceiver(t);
  const payload = feedbackPayload("pl_github_2");
  await postJson(`${unconfigured.baseUrl}/feedback`, payload);

  const rejected = await postJson(`${unconfigured.baseUrl}/feedback/${payload.id}/github-issue`, {});
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /not configured/);

  const github = await startMockGitHub(t, (res) => {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Validation Failed" }));
  });
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPO: "acme/demo",
    GITHUB_API_BASE: github.baseUrl
  });
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const failed = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /Validation Failed/);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].integrations.github.status, "failed");
  assert.equal(stored[0].integrations.github.statusCode, 422);
});

function startMockGitHub(t, respond) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: raw ? JSON.parse(raw) : null
        });
        respond(res, requests[requests.length - 1]);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

test("user-controlled URLs are linked only when they are http(s)", async (t) => {
  const github = await startMockGitHub(t, (res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ number: 1, html_url: "https://github.com/acme/demo/issues/1" }));
  });
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token",
    GITHUB_REPO: "acme/demo",
    GITHUB_API_BASE: github.baseUrl
  });

  const evil = feedbackPayload("pl_xss_1");
  evil.page.url = "javascript:alert(document.domain)";
  await postJson(`${receiver.baseUrl}/feedback`, evil);

  const tricky = feedbackPayload("pl_xss_2");
  tricky.page.url = "https://example.test/a b) [evil](https://evil.test";
  await postJson(`${receiver.baseUrl}/feedback`, tricky);

  const normal = feedbackPayload("pl_xss_3");
  await postJson(`${receiver.baseUrl}/feedback`, normal);

  const inboxHtml = await fetch(`${receiver.baseUrl}/`).then((response) => response.text());
  assert.ok(!inboxHtml.includes('href="javascript:'), "javascript: URL must not become a link");
  assert.match(inboxHtml, /javascript:alert\(document\.domain\)/, "rejected URL is still shown as text");
  assert.ok(inboxHtml.includes('href="http://example.test/demo"'), "http URLs stay linked");

  // GitHub issue body: markdown link only for http(s), wrapped so it cannot break out
  await postJson(`${receiver.baseUrl}/feedback/pl_xss_2/github-issue`, {});
  const trickyBody = github.requests[0].body.body;
  assert.match(trickyBody, /\| Page \| \[.*\]\(<https:\/\/example\.test\/a%20b\)/);
  assert.ok(!trickyBody.includes("[evil](https://evil.test)"), "URL must not escape the link destination");

  await postJson(`${receiver.baseUrl}/feedback/pl_xss_1/github-issue`, {});
  const evilBody = github.requests[1].body.body;
  assert.ok(!evilBody.includes("](javascript:"), "javascript: URL must not become a markdown link");
});

test("POST /feedback/:id/status rejects unknown statuses and ids", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_status_2");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const invalid = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "wontfix" });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /status must be one of/);

  const missing = await postJson(`${receiver.baseUrl}/feedback/pl_missing/status`, { status: "fixed" });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Unknown feedback id/);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].status, undefined);
});

test("corrupt legacy feedback store is backed up, not migrated, during startup", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-receiver-test-"));
  const storePath = path.join(tempDir, "feedback.json");
  const corruptContent = '[{"id": "pl_old", "comment": "truncated...';
  await fs.writeFile(storePath, corruptContent);
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  // The db lives in the same dir so we can confirm migration started empty.
  const receiver = await startReceiver(t, {
    FEEDBACK_STORE_PATH: storePath,
    FEEDBACK_DB_PATH: path.join(tempDir, "feedback.db")
  });
  const payload = feedbackPayload("pl_after_corruption");
  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 201);

  // Only the new item exists; the corrupt legacy rows were not imported.
  const stored = await readStoredFeedback(path.join(tempDir, "feedback.db"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, payload.id);

  const entries = await fs.readdir(tempDir);
  const backup = entries.find((name) => name.startsWith("feedback.json.corrupt-"));
  assert.ok(backup, `expected a corrupt backup file, found: ${entries.join(", ")}`);
  assert.equal(await fs.readFile(path.join(tempDir, backup), "utf8"), corruptContent);
});

test("a valid legacy feedback.json is migrated into sqlite on startup", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-receiver-test-"));
  const storePath = path.join(tempDir, "feedback.json");
  const dbPath = path.join(tempDir, "feedback.db");
  // newest-first on disk, as the JSON store was written
  const legacy = [feedbackPayload("pl_legacy_new"), feedbackPayload("pl_legacy_old")];
  await fs.writeFile(storePath, JSON.stringify(legacy, null, 2));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const receiver = await startReceiver(t, { FEEDBACK_STORE_PATH: storePath, FEEDBACK_DB_PATH: dbPath });

  const stored = await readStoredFeedback(dbPath);
  assert.deepEqual(stored.map((item) => item.id), ["pl_legacy_new", "pl_legacy_old"]);

  // the original is archived, not left in place to re-import
  const entries = await fs.readdir(tempDir);
  assert.ok(!entries.includes("feedback.json"), "legacy store should be archived after migration");
  assert.ok(entries.some((name) => name.startsWith("feedback.json.migrated-")), `expected a migrated archive, found: ${entries.join(", ")}`);

  // the API serves the migrated rows
  const served = await fetch(`${receiver.baseUrl}/feedback.json`).then((r) => r.json());
  assert.deepEqual(served.map((item) => item.id), ["pl_legacy_new", "pl_legacy_old"]);
});

test("GET /widget.js serves the built widget bundle", async (t) => {
  const receiver = await startReceiver(t);

  const response = await fetch(`${receiver.baseUrl}/widget.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/javascript/);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.text();
  const dist = await fs.readFile(path.resolve(__dirname, "../dist/patchloop-widget.js"), "utf8");
  assert.equal(body, dist);
  assert.match(body, /window\.PatchLoop = api;/);
});

test("GET /static serves the inbox assets and rejects traversal", async (t) => {
  const receiver = await startReceiver(t);

  const js = await fetch(`${receiver.baseUrl}/static/inbox.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /text\/javascript/);
  assert.match(await js.text(), /data-status-select/);

  const css = await fetch(`${receiver.baseUrl}/static/inbox.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const missing = await fetch(`${receiver.baseUrl}/static/nope.js`);
  assert.equal(missing.status, 404);
  const traversal = await fetch(`${receiver.baseUrl}/static/..%2Freceive.js`);
  assert.equal(traversal.status, 404);

  const inbox = await fetch(`${receiver.baseUrl}/`).then((response) => response.text());
  assert.ok(inbox.includes('href="/static/inbox.css"'), "inbox links the stylesheet");
  assert.ok(inbox.includes('src="/static/inbox.js"'), "inbox loads the static script");
  assert.ok(!inbox.includes("<style>"), "no inline style block remains");
});

test("routes accept query strings on GET endpoints", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_query_1");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const json = await fetch(`${receiver.baseUrl}/feedback.json?v=2`);
  assert.equal(json.status, 200);
  assert.equal((await json.json())[0].id, payload.id);

  const inbox = await fetch(`${receiver.baseUrl}/?filter=new`);
  assert.equal(inbox.status, 200);
});

test("oversized bodies get a clean 413 instead of a reset connection", async (t) => {
  const receiver = await startReceiver(t, { MAX_BODY_BYTES: "1000" });
  const payload = feedbackPayload("pl_too_big");
  payload.comment = "x".repeat(5000);

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /too large/i);

  // The connection survives for the next request.
  const ok = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_after_413"));
  assert.equal(ok.status, 201);
});

test("non-numeric size limits fall back instead of disabling the limit", async (t) => {
  const receiver = await startReceiver(t, { MAX_BODY_BYTES: "abc" });
  const response = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_nan_env"));
  assert.equal(response.status, 201);

  const big = feedbackPayload("pl_nan_env_big");
  big.comment = "x".repeat(4_000_000);
  const rejected = await postJson(`${receiver.baseUrl}/feedback`, big);
  assert.equal(rejected.status, 413);
});

test("upload-only Slack config reports skipped, not failed, without a screenshot", async (t) => {
  const receiver = await startReceiver(t, {
    SLACK_IMAGE_MODE: "auto",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_UPLOAD_CHANNEL_ID: "C123"
  });
  const payload = feedbackPayload("pl_slack_skip");
  delete payload.screenshot;
  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 201);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].integrations.slack.status, "skipped");
});

test("schemaVersion is stored, defaulted for legacy payloads, and validated", async (t) => {
  const receiver = await startReceiver(t);

  // explicit version is kept
  const versioned = feedbackPayload("pl_schema_1");
  versioned.schemaVersion = 1;
  await postJson(`${receiver.baseUrl}/feedback`, versioned);

  // legacy payload without a version gets the default
  const legacy = feedbackPayload("pl_schema_legacy");
  delete legacy.schemaVersion;
  await postJson(`${receiver.baseUrl}/feedback`, legacy);

  const stored = await readStoredFeedback(receiver.dbPath);
  const byId = Object.fromEntries(stored.map((item) => [item.id, item]));
  assert.equal(byId.pl_schema_1.schemaVersion, 1);
  assert.equal(byId.pl_schema_legacy.schemaVersion, 1);

  // a non-integer version is rejected
  const bad = feedbackPayload("pl_schema_bad");
  bad.schemaVersion = "v1";
  const rejected = await postJson(`${receiver.baseUrl}/feedback`, bad);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /schemaVersion must be an integer/);
});

test("GET /feedback.json filters by projectId, demoId, and status", async (t) => {
  const receiver = await startReceiver(t);

  const a = feedbackPayload("pl_filter_a");
  a.projectId = "alpha";
  a.demoId = "home";
  const b = feedbackPayload("pl_filter_b");
  b.projectId = "alpha";
  b.demoId = "checkout";
  const c = feedbackPayload("pl_filter_c");
  c.projectId = "beta";
  c.demoId = "home";
  for (const p of [a, b, c]) await postJson(`${receiver.baseUrl}/feedback`, p);
  await postJson(`${receiver.baseUrl}/feedback/pl_filter_b/status`, { status: "fixed" });

  const ids = async (query) => {
    const items = await fetch(`${receiver.baseUrl}/feedback.json${query}`).then((r) => r.json());
    return items.map((item) => item.id).sort();
  };

  assert.deepEqual(await ids("?projectId=alpha"), ["pl_filter_a", "pl_filter_b"]);
  assert.deepEqual(await ids("?demoId=home"), ["pl_filter_a", "pl_filter_c"]);
  assert.deepEqual(await ids("?projectId=alpha&demoId=checkout"), ["pl_filter_b"]);
  assert.deepEqual(await ids("?status=fixed"), ["pl_filter_b"]);
  assert.deepEqual(await ids("?projectId=beta&demoId=checkout"), []);

  const badStatus = await fetch(`${receiver.baseUrl}/feedback.json?status=wontfix`);
  assert.equal(badStatus.status, 400);
});

test("inbox exposes project and demo filters with the data attributes", async (t) => {
  const receiver = await startReceiver(t);
  const item = feedbackPayload("pl_inbox_filter");
  item.projectId = "alpha";
  item.demoId = "home";
  await postJson(`${receiver.baseUrl}/feedback`, item);

  const html = await fetch(`${receiver.baseUrl}/`).then((r) => r.text());
  assert.match(html, /data-filter-key="project"/);
  assert.match(html, /data-filter-key="demo"/);
  assert.match(html, /data-project="alpha"/);
  assert.match(html, /data-demo="home"/);
});

test("DELETE /feedback/:id removes the item and its screenshot file", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_delete_1");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_delete_keep"));

  const before = await readStoredFeedback(receiver.dbPath);
  const screenshotPath = before.find((item) => item.id === "pl_delete_1").screenshot.path;
  await fs.access(screenshotPath); // exists before delete

  const response = await fetch(`${receiver.baseUrl}/feedback/pl_delete_1`, { method: "DELETE" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, id: "pl_delete_1", count: 1 });

  const after = await readStoredFeedback(receiver.dbPath);
  assert.deepEqual(after.map((item) => item.id), ["pl_delete_keep"]);
  await assert.rejects(fs.access(screenshotPath), /ENOENT/);
});

test("DELETE /feedback/:id returns 404 for an unknown id", async (t) => {
  const receiver = await startReceiver(t);
  await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_delete_present"));

  const response = await fetch(`${receiver.baseUrl}/feedback/pl_missing`, { method: "DELETE" });
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Unknown feedback id/);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
});

test("inbox renders a delete button per card", async (t) => {
  const receiver = await startReceiver(t);
  await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_delete_ui"));
  const html = await fetch(`${receiver.baseUrl}/`).then((r) => r.text());
  assert.match(html, /data-delete-feedback data-feedback-id="pl_delete_ui"/);
});

test("POST /feedback rejects a duplicate id instead of overwriting", async (t) => {
  const receiver = await startReceiver(t);
  const first = feedbackPayload("pl_dup");
  first.comment = "original";
  await postJson(`${receiver.baseUrl}/feedback`, first);

  const second = feedbackPayload("pl_dup");
  second.comment = "should not overwrite";
  const response = await postJson(`${receiver.baseUrl}/feedback`, second);
  assert.equal(response.status, 409);
  assert.match(response.body.error, /already exists/);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].comment, "original");

  // The rejected duplicate must not orphan the screenshot it wrote: one stored
  // row means exactly one screenshot file (regression for #82).
  const files = await fs.readdir(receiver.screenshotDir);
  assert.equal(files.length, 1);
});

test("POST /feedback 409 cleanup cannot delete another record's screenshot", async (t) => {
  const receiver = await startReceiver(t);
  await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_victim"));
  const before = await fs.readdir(receiver.screenshotDir);
  assert.equal(before.length, 1);
  const victimFile = before[0];

  // Re-use an existing id (-> 409) with a crafted screenshot that points at the
  // victim's stored file. saveScreenshot must strip the client-supplied path so
  // the 409 cleanup (deleteScreenshotFile) cannot touch a file we did not write.
  const attack = feedbackPayload("pl_victim");
  attack.screenshot = { status: "saved", path: path.join(receiver.screenshotDir, victimFile) };
  const response = await postJson(`${receiver.baseUrl}/feedback`, attack);
  assert.equal(response.status, 409);

  const after = await fs.readdir(receiver.screenshotDir);
  assert.deepEqual(after, [victimFile]);
});

test("POST /feedback keeps omitted screenshot metadata (bytes/maxBytes)", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_omitted");
  // The widget sends this shape when the capture is too large; receiver renders
  // "omitted: <bytes> bytes exceeds <maxBytes>". Stripping server-owned fields
  // must not drop this legitimate client metadata.
  payload.screenshot = { status: "omitted", reason: "too-large", kind: "viewport-svg", bytes: 99999, maxBytes: 1000 };
  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 201);

  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored[0].screenshot.status, "omitted");
  assert.equal(stored[0].screenshot.bytes, 99999);
  assert.equal(stored[0].screenshot.maxBytes, 1000);
});

async function startReceiver(t, extraEnv = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-receiver-test-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storePath = path.join(tempDir, "feedback.json");
  const dbPath = path.join(tempDir, "feedback.db");
  const screenshotDir = path.join(tempDir, "screenshots");

  const child = spawn(process.execPath, [RECEIVER_PATH], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      FEEDBACK_STORE_PATH: storePath,
      FEEDBACK_DB_PATH: dbPath,
      SCREENSHOT_DIR: screenshotDir,
      PUBLIC_BASE_URL: baseUrl,
      SLACK_WEBHOOK_URL: "",
      SLACK_IMAGE_MODE: "off",
      SLACK_BOT_TOKEN: "",
      SLACK_UPLOAD_CHANNEL_ID: "",
      GITHUB_TOKEN: "",
      GITHUB_REPO: "",
      PATCHLOOP_RECEIVER_CONFIG: path.join(tempDir, "missing-config.json"),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logs = await waitForReceiver(child);

  t.after(async () => {
    child.kill();
    await waitForExit(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  return {
    baseUrl,
    logs,
    screenshotDir,
    storePath,
    dbPath,
    tempDir
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForReceiver(child) {
  let output = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Receiver did not start in time.\n${output}`));
    }, 5000);

    const onStdout = (chunk) => {
      output += chunk.toString();
      if (output.includes("[PatchLoop receiver] listening")) {
        cleanup();
        resolve(output);
      }
    };

    const onStderr = (chunk) => {
      output += chunk.toString();
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Receiver exited before startup: code=${code} signal=${signal}\n${output}`));
    };

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

// Reads the sqlite store directly (newest first, matching store.list) so the
// tests can assert persisted state without going through the HTTP API.
async function readStoredFeedback(dbPath) {
  try {
    await fs.access(dbPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT data FROM feedback ORDER BY seq DESC").all().map((row) => JSON.parse(row.data));
  } finally {
    db.close();
  }
}

function feedbackPayload(id) {
  return {
    schemaVersion: 1,
    id,
    projectId: "patchloop",
    demoId: "receiver-test",
    comment: "Move this button above the fold.",
    reviewer: "Test Reviewer",
    page: {
      url: "http://example.test/demo",
      title: "Example Demo"
    },
    target: {
      kind: "point",
      x: 12.5,
      y: 20.25,
      clientX: 100,
      clientY: 120,
      pageX: 100,
      pageY: 120,
      documentX: 12.5,
      documentY: 20.25,
      selector: "#hero button",
      text: "Start"
    },
    environment: {
      viewport: {
        width: 1280,
        height: 720
      },
      browser: "node:test",
      language: "en-US"
    },
    screenshot: {
      status: "captured",
      kind: "viewport-svg",
      mimeType: "image/svg+xml",
      width: 1280,
      height: 720,
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(testSvg()).toString("base64")}`
    },
    createdAt: "2026-06-03T00:00:00.000Z"
  };
}

function testSvg() {
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\" fill=\"#fff\"/></svg>";
}
