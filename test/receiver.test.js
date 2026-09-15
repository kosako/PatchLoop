"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { once } = require("node:events");
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
  assert.equal(stored[0].screenshot.fileName, path.basename(stored[0].screenshot.path));

  const screenshotFile = await fs.readFile(stored[0].screenshot.path, "utf8");
  assert.equal(screenshotFile, testSvg());

  const screenshotResponse = await fetch(stored[0].screenshot.url);
  assert.equal(screenshotResponse.status, 200);
  assert.match(screenshotResponse.headers.get("content-type"), /^image\/svg\+xml/);
  assert.equal(await screenshotResponse.text(), testSvg());
  // An attacker-supplied SVG must not execute if opened directly: the serving
  // response carries sandboxing headers (stored-XSS hardening, #44).
  assert.equal(screenshotResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(screenshotResponse.headers.get("content-security-policy"), "default-src 'none'; sandbox");
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

test("outgoing feedback omits the internal screenshot path while storage and cleanup retain it", async (t) => {
  const github = await startMockGitHub(t, (res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ number: 12, html_url: "https://github.com/acme/demo/issues/12" }));
  });
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token", GITHUB_REPO: "acme/demo", GITHUB_API_BASE: github.baseUrl
  });
  const payload = feedbackPayload("pl_export_privacy");
  payload.sourceContext = { repo: "acme/demo", root: "web", branch: "main" };
  payload.extra = { path: "public-source-path", message: "keep this field" };
  payload.screenshot.extra = { path: "public-image-metadata" };
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, payload)).status, 201);

  const [stored] = await readStoredFeedback(receiver.dbPath);
  const internalPath = stored.screenshot.path;
  assert.equal(path.dirname(internalPath), receiver.screenshotDir);
  assert.equal(await fs.readFile(internalPath, "utf8"), testSvg());

  for (const suffix of ["", "?projectId=patchloop"]) {
    const response = await fetch(`${receiver.baseUrl}/feedback.json${suffix}`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.equal(raw.includes(internalPath), false);
    const [exported] = JSON.parse(raw);
    assert.equal(Object.hasOwn(exported.screenshot, "path"), false);
    assert.equal(exported.screenshot.url, stored.screenshot.url);
    assert.deepEqual(exported.sourceContext, payload.sourceContext);
    assert.deepEqual(exported.extra, payload.extra);
    assert.deepEqual(exported.screenshot.extra, payload.screenshot.extra);
  }

  const inbox = await fetch(receiver.baseUrl);
  const html = await inbox.text();
  assert.equal(inbox.status, 200);
  assert.equal(html.includes(internalPath), false);
  assert.ok(html.includes(stored.screenshot.url));
  assert.ok(html.includes("public-source-path"));
  assert.ok(html.includes("public-image-metadata"));

  assert.equal((await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {})).status, 201);
  const body = github.requests[0].body.body;
  assert.equal(body.includes(internalPath), false);
  const issuePayload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)[1]);
  assert.equal(Object.hasOwn(issuePayload.screenshot, "path"), false);
  assert.equal(issuePayload.screenshot.url, stored.screenshot.url);
  assert.deepEqual(issuePayload.sourceContext, payload.sourceContext);
  assert.deepEqual(issuePayload.extra, payload.extra);
  assert.deepEqual(issuePayload.screenshot.extra, payload.screenshot.extra);

  const [afterExport] = await readStoredFeedback(receiver.dbPath);
  assert.equal(afterExport.screenshot.path, internalPath);
  const removed = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  await assert.rejects(fs.access(internalPath), { code: "ENOENT" });
});

test("POST /feedback stores the sourceContext block as sent (#96)", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_source_context");
  payload.sourceContext = {
    repo: "acme/shop",
    branch: "feature/checkout",
    commit: "abc1234",
    root: "apps/web",
    buildUrl: "https://ci.example/build/1",
    previewUrl: "https://preview.example/pr-1"
  };

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);

  assert.equal(response.status, 201);
  const stored = await readStoredFeedback(receiver.dbPath);
  assert.deepEqual(stored[0].sourceContext, payload.sourceContext);
});

test("live ingest cannot assert receiver history or local delivery markers", async (t) => {
  const receiver = await startReceiver(t);
  const payload = {
    ...feedbackPayload("pl_receiver_owned"),
    receivedAt: "2000-01-01T00:00:00.000Z", importedAt: "2000-01-01T00:00:00.000Z",
    source: "import", received: { origin: "https://other.example", originAllowed: true },
    status: "ignored", statusUpdatedAt: "2000-01-01T00:00:00.000Z",
    integrations: { github: { status: "created", issueNumber: 1 } },
    delivery: { ok: true }, exported: true, exportedAt: "old", exportedFileName: "old.json"
  };
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, payload)).status, 201);
  const [stored] = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.source, undefined); // Live records use the receiver default.
  assert.equal(stored.status, "new");
  assert.notEqual(stored.receivedAt, payload.receivedAt);
  assert.deepEqual(stored.received, { origin: null, originAllowed: true });
  assert.deepEqual(stored.integrations, { slack: { status: "disabled" } });
  for (const field of ["importedAt", "statusUpdatedAt", "delivery", "exported", "exportedAt", "exportedFileName"]) {
    assert.equal(stored[field], undefined, field);
  }
});

test("live and import reject malformed known metadata before persisting", async (t) => {
  const receiver = await startReceiver(t);
  const cases = [
    ["environment", "viewport", { width: { toString: 1 }, height: 720 }],
    ["environment", "browser", {}],
    ["target", "clientX", "100"],
    ["target", "area", { clientWidth: [] }],
    ["target", "anchor", { selector: {} }],
    ["screenshot", "width", {}],
    ["screenshot", "error", []]
  ];
  for (const [group, field, value] of cases) {
    const payload = feedbackPayload(`pl_invalid_${group}_${field}`);
    payload[group][field] = value;
    for (const route of ["feedback", "import"]) {
      const response = await postJson(`${receiver.baseUrl}/${route}`, payload);
      assert.equal(response.status, 400, `${route}: ${group}.${field}`);
    }
  }
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
  await assert.rejects(fs.access(receiver.screenshotDir), { code: "ENOENT" });
});

test("JSON mutations require JSON media type with session or API authentication", async (t) => {
  const receiver = await startReceiver(t, { RECEIVER_TOKEN: "test-session-token" });
  const payload = feedbackPayload("pl_json_contract");
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, payload)).status, 201);
  const login = await fetch(`${receiver.baseUrl}/login`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=test-session-token", redirect: "manual"
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const requests = [
    ["/feedback", feedbackPayload("pl_simple_ingest")],
    ["/import", feedbackPayload("pl_simple_import")],
    [`/feedback/${payload.id}/status`, { status: "fixed" }],
    [`/feedback/${payload.id}/github-issue`, {}]
  ];
  for (const [route, body] of requests) {
    for (const mediaType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await fetch(`${receiver.baseUrl}${route}`, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": mediaType, Origin: "http://demo.example" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 415, `${route}: ${mediaType}`);
    }
    const missingType = await fetch(`${receiver.baseUrl}${route}`, {
      method: "POST", headers: { Authorization: "Bearer test-session-token" }
    });
    assert.equal(missingType.status, 415, `${route}: no media type`);
  }
  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "new");
  const accepted = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "fixed" }, {
    Cookie: cookie, "Content-Type": "Application/JSON; charset=UTF-8"
  });
  assert.equal(accepted.status, 200);
});

test("malformed encoded feedback IDs return 400 without stopping the receiver", async (t) => {
  const receiver = await startReceiver(t);
  for (const [method, suffix] of [["DELETE", ""], ["POST", "/status"], ["POST", "/github-issue"]]) {
    const response = await fetch(`${receiver.baseUrl}/feedback/%ZZ${suffix}`, {
      method, headers: { "Content-Type": "application/json" }, body: "{}"
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Invalid feedback ID encoding/);
    assert.equal((await fetch(`${receiver.baseUrl}/healthz`)).status, 200);
  }
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_after_bad_id"))).status, 201);
});

for (const headersSent of [false, true]) {
  test(`synchronous route failures are logged and contained with headersSent=${headersSent}`, async (t) => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-route-fault-"));
    t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
    const preload = path.join(fixtureDir, "fail-response.cjs");
    // Inject one native response failure in the receiver child. The real login
    // route and dispatcher run unchanged, including Node's headersSent behavior.
    await fs.writeFile(preload, `
      const http = require("node:http");
      const writeHead = http.ServerResponse.prototype.writeHead;
      let faulted = false;
      http.ServerResponse.prototype.writeHead = function (...args) {
        if (!faulted && this.req.url === "/login?fault=sync") {
          faulted = true;
          if (${headersSent}) writeHead.apply(this, args);
          throw new Error("Synthetic route failure");
        }
        return writeHead.apply(this, args);
      };
    `);
    const receiver = await startReceiver(t, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
    let stderr = "";
    receiver.child.stderr.on("data", (chunk) => { stderr += chunk; });
    const target = `${receiver.baseUrl}/login?fault=sync`;
    if (headersSent) {
      await assert.rejects(async () => {
        const response = await fetch(target);
        await response.text();
      });
    } else {
      const response = await fetch(target);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { ok: false, error: "Internal Server Error" });
    }
    assert.equal((await fetch(`${receiver.baseUrl}/healthz`)).status, 200);
    receiver.child.kill();
    await waitForExit(receiver.child);
    assert.match(stderr, /\[PatchLoop receiver\] route handler failed: Error: Synthetic route failure/);
    assert.doesNotMatch(stderr, /ERR_HTTP_HEADERS_SENT/);
  });
}

test("Inbox rendering failures return 500 without stopping the receiver", async (t) => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-inbox-fault-"));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const preload = path.join(fixtureDir, "fail-render.cjs");
  // Fail only the first render in the child; the production HTTP route, store,
  // and native response are unchanged.
  await fs.writeFile(preload, `
    const inboxView = require(${JSON.stringify(path.join(path.dirname(RECEIVER_PATH), "inbox-view.js"))});
    const createInboxView = inboxView.createInboxView;
    inboxView.createInboxView = (deps) => {
      const view = createInboxView(deps);
      let faulted = false;
      return { ...view, renderInbox(items) {
        if (!faulted) {
          faulted = true;
          throw new Error("Synthetic inbox render failure");
        }
        return view.renderInbox(items);
      } };
    };
  `);
  const receiver = await startReceiver(t, { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
  let stderr = "";
  receiver.child.stderr.on("data", (chunk) => { stderr += chunk; });
  const failed = await fetch(receiver.baseUrl);
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), "Internal Server Error");
  assert.equal((await fetch(`${receiver.baseUrl}/healthz`)).status, 200);
  const retried = await fetch(receiver.baseUrl);
  assert.equal(retried.status, 200);
  assert.match(await retried.text(), /<html/);
  receiver.child.kill();
  await waitForExit(receiver.child);
  assert.match(stderr, /inbox render failed: Synthetic inbox render failure/);
  assert.doesNotMatch(stderr, /ERR_HTTP_HEADERS_SENT/);
});

test("legacy malformed metadata cannot prevent the Inbox from showing other records", async (t) => {
  const receiver = await startReceiver(t);
  const invalid = feedbackPayload("pl_legacy_invalid");
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, invalid)).status, 201);
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_legacy_healthy"))).status, 201);
  invalid.environment.viewport.width = { toString: 1 };
  invalid.reviewer = { toString: 1 };
  const db = new DatabaseSync(receiver.dbPath);
  try {
    db.prepare("UPDATE feedback SET data = ? WHERE id = ?").run(JSON.stringify(invalid), invalid.id);
  } finally {
    db.close();
  }
  const response = await fetch(receiver.baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /保存済みメタデータの形式が不正/);
  assert.match(html, /data-feedback-id="pl_legacy_invalid"/);
  assert.match(html, /data-feedback-id="pl_legacy_healthy"/);
  assert.match(html, /&quot;toString&quot;: 1/);
});

test("POST /feedback validates the sourceContext shape", async (t) => {
  const receiver = await startReceiver(t);

  const notAnObject = feedbackPayload("pl_source_context_string");
  notAnObject.sourceContext = "acme/shop@abc1234";
  const objectResponse = await postJson(`${receiver.baseUrl}/feedback`, notAnObject);
  assert.equal(objectResponse.status, 400);
  assert.match(objectResponse.body.error, /feedback\.sourceContext must be an object/);

  const badField = feedbackPayload("pl_source_context_field");
  badField.sourceContext = { repo: "acme/shop", commit: 1234 };
  const fieldResponse = await postJson(`${receiver.baseUrl}/feedback`, badField);
  assert.equal(fieldResponse.status, 400);
  assert.match(fieldResponse.body.error, /feedback\.sourceContext\.commit must be a string/);

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

test("GitHub issue body degrades the screenshot embed to a link when auth is enabled", async (t) => {
  const github = await startMockGitHub(t, (res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ number: 8, html_url: "https://github.com/acme/demo/issues/8" }));
  });
  const receiver = await startReceiver(t, {
    RECEIVER_TOKEN: "s3cret",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPO: "acme/demo",
    GITHUB_API_BASE: github.baseUrl
  });
  const payload = feedbackPayload("pl_github_auth");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const response = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {}, { Authorization: "Bearer s3cret" });
  assert.equal(response.status, 201);

  // GitHub's image proxy cannot authenticate, so an inline embed would always
  // break; the body keeps only the direct link.
  const body = github.requests[0].body.body;
  assert.doesNotMatch(body, /!\[PatchLoop screenshot\]/);
  assert.match(body, /\[Open screenshot\]\(/);
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
  assert.equal(stored[0].status, "new");
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

test("POST /feedback rejects an oversized text field with 413", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_long_field");
  // Under MAX_BODY_BYTES (3MB) but over the per-field length cap (20k default):
  // a multi-MB comment would otherwise be copied verbatim into a GitHub issue.
  payload.comment = "x".repeat(20_001);

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /maximum length/i);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("POST /feedback rejects a too-deeply nested payload with 413", async (t) => {
  const receiver = await startReceiver(t, { MAX_OBJECT_DEPTH: "4" });
  const payload = feedbackPayload("pl_deep");
  // environment is stored as-is, so an attacker can bury arbitrary nesting here.
  payload.environment.extra = { a: { b: { c: { d: "deep" } } } };

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /nesting depth/i);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("POST /feedback rejects an oversized array with 413", async (t) => {
  const receiver = await startReceiver(t, { MAX_ARRAY_LENGTH: "3" });
  const payload = feedbackPayload("pl_big_array");
  payload.environment.tags = ["a", "b", "c", "d"];

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /entries/i);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("payload size limits exempt the screenshot dataUrl", async (t) => {
  // The base64 dataUrl is legitimately long and bounded by SCREENSHOT_MAX_BYTES,
  // not the generic field-length cap; a tiny MAX_FIELD_LENGTH must not reject it.
  const receiver = await startReceiver(t, { MAX_FIELD_LENGTH: "50" });
  const payload = feedbackPayload("pl_screenshot_exempt");
  payload.comment = "short comment";

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 201);
  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].screenshot.status, "saved");
});

test("POST /import rejects a bundle with too many items with 413", async (t) => {
  const receiver = await startReceiver(t, { MAX_IMPORT_ITEMS: "2" });
  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: [
      feedbackPayload("pl_imp_1"),
      feedbackPayload("pl_imp_2"),
      feedbackPayload("pl_imp_3")
    ]
  });

  assert.equal(response.status, 413);
  assert.match(response.body.error, /maximum of 2 items/i);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("nested screenshot keys cannot bypass the nesting-depth cap", async (t) => {
  // Regression: exempting the whole screenshot subtree let a crafted
  // environment.screenshot bury deep nesting that bypassed the depth cap and
  // overflowed the store's JSON.stringify (surfacing as a 500).
  const receiver = await startReceiver(t, { MAX_OBJECT_DEPTH: "4" });
  const payload = feedbackPayload("pl_nested_shot");
  payload.environment.screenshot = { a: { b: { c: { d: "deep" } } } };

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /nesting depth/i);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("only the screenshot dataUrl is exempt, not other screenshot fields", async (t) => {
  const receiver = await startReceiver(t, { MAX_FIELD_LENGTH: "50" });
  const payload = feedbackPayload("pl_shot_caption");
  payload.comment = "short";
  payload.screenshot.caption = "y".repeat(51);

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /maximum length/i);
});

test("a dataUrl key outside the screenshot is still length-capped", async (t) => {
  // The exemption is scoped to the real feedback.screenshot.dataUrl, not any
  // field named dataUrl: otherwise environment.dataUrl could carry an oversized
  // string past the cap and into the GitHub issue body's raw-payload dump.
  const receiver = await startReceiver(t, { MAX_FIELD_LENGTH: "50" });
  const payload = feedbackPayload("pl_fake_dataurl");
  payload.comment = "short";
  payload.environment.dataUrl = "z".repeat(51);

  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 413);
  assert.match(response.body.error, /maximum length/i);
});

test("non-positive shape limits fall back to the default instead of bricking", async (t) => {
  // 0 / negative would reject nearly every request; treat as a misconfig.
  const receiver = await startReceiver(t, {
    MAX_FIELD_LENGTH: "0",
    MAX_OBJECT_DEPTH: "-3",
    MAX_IMPORT_ITEMS: "0"
  });
  const ok = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_zero_limits"));
  assert.equal(ok.status, 201);

  // The default cap (20000) is still in force, so a genuinely oversized field
  // is rejected rather than the limit being disabled.
  const big = feedbackPayload("pl_zero_limits_big");
  big.comment = "x".repeat(20_001);
  const rejected = await postJson(`${receiver.baseUrl}/feedback`, big);
  assert.equal(rejected.status, 413);
});

test("rate limiting returns 429 with Retry-After once the window is exceeded", async (t) => {
  const receiver = await startReceiver(t, { RATE_LIMIT_MAX: "2" });
  const url = `${receiver.baseUrl}/feedback.json`;

  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 200);
  const limited = await fetch(url);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("the rate-limit map is hard-capped, evicting old clients under churn", async (t) => {
  // Regression: previously only expired buckets were swept, so an IP-spoofing
  // flood with every bucket active grew the map without bound. With a hard cap,
  // a new client evicts the oldest, which both bounds memory and lets the
  // evicted IP start a fresh window.
  const receiver = await startReceiver(t, {
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_MAX_CLIENTS: "1",
    RECEIVER_TRUST_PROXY: "1"
  });
  const get = (ip) => fetch(`${receiver.baseUrl}/feedback.json`, { headers: { "X-Forwarded-For": ip } });

  assert.equal((await get("10.0.0.1")).status, 200); // A: first request in window
  assert.equal((await get("10.0.0.1")).status, 429); // A: over the limit
  assert.equal((await get("10.0.0.2")).status, 200); // B: new client evicts A (cap 1)
  // A was evicted, so it gets a fresh bucket and is allowed again. Without a
  // hard cap (expired-only sweep) A would still be throttled (429).
  assert.equal((await get("10.0.0.1")).status, 200);
});

test("preflight OPTIONS requests are not rate limited", async (t) => {
  const receiver = await startReceiver(t, { RATE_LIMIT_MAX: "1" });
  const url = `${receiver.baseUrl}/feedback.json`;

  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(url, { method: "OPTIONS" })).status, 204);
  }
  // The OPTIONS calls didn't consume the budget: the first GET still passes,
  // the second is throttled.
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 429);
});

test("known paths reject unsupported methods with 405 and an Allow header", async (t) => {
  const receiver = await startReceiver(t);

  const fixed = await fetch(`${receiver.baseUrl}/feedback`, { method: "GET" });
  assert.equal(fixed.status, 405);
  assert.equal(fixed.headers.get("allow"), "POST, OPTIONS");
  assert.deepEqual(await fixed.json(), { ok: false, error: "Method Not Allowed" });

  // Parameterized paths are recognized across methods too.
  const parameterized = await fetch(`${receiver.baseUrl}/feedback/pl_x`, { method: "PUT" });
  assert.equal(parameterized.status, 405);
  assert.equal(parameterized.headers.get("allow"), "DELETE, OPTIONS");
});

test("unknown paths still return 404", async (t) => {
  const receiver = await startReceiver(t);

  const response = await fetch(`${receiver.baseUrl}/no-such-route`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not Found");
});

test("X-Forwarded-For is ignored for rate limiting unless trust proxy is set", async (t) => {
  const receiver = await startReceiver(t, { RATE_LIMIT_MAX: "1" });
  const url = `${receiver.baseUrl}/feedback.json`;

  assert.equal((await fetch(url, { headers: { "X-Forwarded-For": "1.1.1.1" } })).status, 200);
  // Different spoofed header, same socket: without trust-proxy it can't buy a
  // fresh bucket.
  assert.equal((await fetch(url, { headers: { "X-Forwarded-For": "2.2.2.2" } })).status, 429);
});

test("POST /feedback reports capacity database failures as server errors before writing", async (t) => {
  const receiver = await startReceiver(t);
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_capacity_before_failure"))).status, 201);
  const before = await readStoredFeedback(receiver.dbPath);
  const files = await fs.readdir(receiver.screenshotDir);
  const db = new DatabaseSync(receiver.dbPath);
  try {
    db.exec("ALTER TABLE feedback RENAME TO unavailable_feedback");
    const rejected = feedbackPayload("pl_capacity_db_failure");
    const response = await postJson(`${receiver.baseUrl}/feedback`, rejected);
    assert.equal(response.status, 500);
    assert.equal(response.body.ok, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM unavailable_feedback").get().n, 1);
    assert.deepEqual(await fs.readdir(receiver.screenshotDir), files);
    db.exec("ALTER TABLE unavailable_feedback RENAME TO feedback");
    assert.deepEqual(await readStoredFeedback(receiver.dbPath), before);
    assert.equal((await postJson(`${receiver.baseUrl}/feedback`, rejected)).status, 201);
  } finally {
    db.close();
  }
});

test("POST /feedback returns 507 once the stored feedback limit is reached", async (t) => {
  const receiver = await startReceiver(t, { MAX_FEEDBACK_COUNT: "1" });
  const first = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_cap_1"));
  assert.equal(first.status, 201);

  const second = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_cap_2"));
  assert.equal(second.status, 507);
  assert.match(second.body.error, /limit reached/i);

  // Rejected before the screenshot was written, so no orphan file and the store
  // is unchanged.
  assert.equal((await readStoredFeedback(receiver.dbPath)).length, 1);
  assert.equal((await fs.readdir(receiver.screenshotDir)).length, 1);
});

test("POST /import returns 507 when the batch would exceed the stored limit", async (t) => {
  const receiver = await startReceiver(t, { MAX_FEEDBACK_COUNT: "1" });
  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle",
    version: 2,
    feedback: [feedbackPayload("pl_cap_imp_1"), feedbackPayload("pl_cap_imp_2")]
  });

  assert.equal(response.status, 507);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);
});

test("screenshot disk cap returns 507 and frees bytes on delete", async (t) => {
  const svgBytes = Buffer.byteLength(testSvg());
  // Room for exactly one screenshot, so a second one trips the cap.
  const receiver = await startReceiver(t, { SCREENSHOT_DISK_MAX_BYTES: String(svgBytes + 10) });

  const first = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_disk_1"));
  assert.equal(first.status, 201);

  const second = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_disk_2"));
  assert.equal(second.status, 507);
  assert.match(second.body.error, /storage limit reached/i);

  // Deleting the first frees its bytes, so a fresh screenshot fits again —
  // proving the running counter is decremented on delete.
  const del = await fetch(`${receiver.baseUrl}/feedback/pl_disk_1`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const third = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_disk_3"));
  assert.equal(third.status, 201);
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

async function prepareScreenshotCleanupFailure(t) {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-cleanup-failure-"));
  t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
  const triggerPath = path.join(fixtureDir, "fail-cleanup");
  const racePath = path.join(fixtureDir, "concurrent-feedback.json");
  const preload = path.join(fixtureDir, "block-cleanup.cjs");
  // Replace only the rejected upload with a nonempty directory. unlink then
  // fails with a real I/O error even when CI runs with elevated permissions.
  await fs.writeFile(preload, `
      const fs = require("node:fs");
      const path = require("node:path");
      const writeFile = fs.writeFileSync;
      fs.writeFileSync = (filePath, ...args) => {
        const result = writeFile(filePath, ...args);
        if (path.dirname(filePath) === process.env.SCREENSHOT_DIR && fs.existsSync(${JSON.stringify(triggerPath)})) {
          fs.renameSync(filePath, filePath + ".retained");
          fs.mkdirSync(filePath);
          fs.renameSync(filePath + ".retained", path.join(filePath, "retained.svg"));
          if (fs.existsSync(${JSON.stringify(racePath)})) {
            const item = JSON.parse(fs.readFileSync(${JSON.stringify(racePath)}, "utf8"));
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.env.FEEDBACK_DB_PATH);
            try {
              db.prepare("INSERT INTO feedback (id, data) VALUES (?, ?)").run(item.id, JSON.stringify(item));
            } finally {
              db.close();
            }
            fs.unlinkSync(${JSON.stringify(racePath)});
          }
        }
        return result;
      };
  `);
  return { triggerPath, racePath, preload };
}

for (const failure of ["duplicate", "database"]) {
  test(`POST /feedback preserves the ${failure} insert error when screenshot cleanup fails`, async (t) => {
    const { triggerPath, preload } = await prepareScreenshotCleanupFailure(t);
    const slack = await startMockGitHub(t, (res) => res.end("ok"));
    const receiver = await startReceiver(t, {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      SLACK_WEBHOOK_URL: slack.baseUrl
    });
    const errors = [];
    receiver.child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
    const existing = feedbackPayload(`pl_cleanup_${failure}`);
    assert.equal((await postJson(`${receiver.baseUrl}/feedback`, existing)).status, 201);
    const before = await readStoredFeedback(receiver.dbPath);
    await fs.writeFile(triggerPath, "enabled");
    const rejected = feedbackPayload(failure === "duplicate" ? existing.id : "pl_cleanup_db_rejected");
    const db = new DatabaseSync(receiver.dbPath);
    try {
      if (failure === "database") {
        db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON feedback BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END");
      }
      const response = await postJson(`${receiver.baseUrl}/feedback`, rejected);
      assert.equal(response.status, failure === "duplicate" ? 409 : 500);
      assert.deepEqual(response.body, {
        ok: false,
        error: failure === "duplicate" ? `feedback id already exists: ${existing.id}` : "injected insert failure"
      });
      assert.deepEqual(await readStoredFeedback(receiver.dbPath), before);
      assert.equal(slack.requests.length, 1);
      const entries = await fs.readdir(receiver.screenshotDir, { withFileTypes: true });
      const blocked = entries.find((entry) => entry.isDirectory());
      assert.ok(blocked);
      const blockedPath = path.join(receiver.screenshotDir, blocked.name);
      assert.equal((await fs.readFile(path.join(blockedPath, "retained.svg"))).length, before[0].screenshot.bytes);
      const closed = once(receiver.child, "close");
      receiver.child.kill();
      await closed;
      assert.match(errors.join(""), /failed to clean up screenshot/);
      assert.ok(errors.join("").includes(rejected.id));
      assert.ok(errors.join("").includes(blockedPath));
    } finally {
      db.close();
    }
  });
}

for (const failure of ["duplicate", "database"]) {
  test(`POST /import preserves the ${failure} insert classification when screenshot cleanup fails`, async (t) => {
    const { triggerPath, racePath, preload } = await prepareScreenshotCleanupFailure(t);
    const slack = await startMockGitHub(t, (res) => res.end("unexpected"));
    const receiver = await startReceiver(t, {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      SLACK_WEBHOOK_URL: slack.baseUrl
    });
    const errors = [];
    receiver.child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
    const rejected = feedbackPayload(`pl_import_cleanup_${failure}`);
    const raced = { ...rejected, comment: "concurrent writer" };
    delete raced.screenshot;
    await fs.writeFile(triggerPath, "enabled");
    const db = new DatabaseSync(receiver.dbPath);
    try {
      if (failure === "duplicate") {
        // Insert after import's duplicate pre-check, while saveScreenshot is
        // writing, so the real UNIQUE constraint rejects the import insert.
        await fs.writeFile(racePath, JSON.stringify(raced));
      } else {
        db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON feedback BEGIN SELECT RAISE(ABORT, 'injected import failure'); END");
      }
      const response = await postJson(`${receiver.baseUrl}/import`, rejected);
      assert.equal(response.status, failure === "duplicate" ? 409 : 400);
      assert.deepEqual(response.body, {
        ok: false,
        ids: [],
        imported: 0,
        duplicates: failure === "duplicate" ? [rejected.id] : [],
        failed: failure === "duplicate" ? [] : [{ id: rejected.id, error: "injected import failure" }],
        count: failure === "duplicate" ? 1 : 0,
        source: "import"
      });
      assert.deepEqual(await readStoredFeedback(receiver.dbPath), failure === "duplicate" ? [raced] : []);
      assert.equal(slack.requests.length, 0);
      const entries = await fs.readdir(receiver.screenshotDir, { withFileTypes: true });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].isDirectory(), true);
      const blockedPath = path.join(receiver.screenshotDir, entries[0].name);
      assert.equal((await fs.readFile(path.join(blockedPath, "retained.svg"))).length, Buffer.byteLength(testSvg()));
      assert.equal(JSON.stringify(response.body).includes(receiver.tempDir), false);
      const closed = once(receiver.child, "close");
      receiver.child.kill();
      await closed;
      assert.match(errors.join(""), /failed to clean up screenshot/);
      assert.ok(errors.join("").includes(rejected.id));
      assert.ok(errors.join("").includes(blockedPath));
    } finally {
      db.close();
    }
  });
}

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

test("protected endpoints require the shared token when RECEIVER_TOKEN is set", async (t) => {
  const receiver = await startReceiver(t, { RECEIVER_TOKEN: "s3cret" });
  const payload = feedbackPayload("pl_auth_1");

  // Ingest (POST /feedback) is the widget path and stays open.
  const ingest = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(ingest.status, 201);

  // Reads are protected too: JSON/resources return 401, the inbox page
  // redirects an unauthenticated browser to the login form.
  const read = await fetch(`${receiver.baseUrl}/feedback.json`);
  assert.equal(read.status, 401);
  const inbox = await fetch(receiver.baseUrl, { redirect: "manual" });
  assert.equal(inbox.status, 303);
  assert.equal(inbox.headers.get("location"), "/login");
  const stored = await readStoredFeedback(receiver.dbPath);
  const screenshotNoToken = await fetch(stored[0].screenshot.url);
  assert.equal(screenshotNoToken.status, 401);

  // The widget bundle stays public: demo pages load it cross-origin.
  const widget = await fetch(`${receiver.baseUrl}/widget.js`);
  assert.notEqual(widget.status, 401);

  // Every operation endpoint rejects a missing token (permission boundary).
  const importNoToken = await postJson(`${receiver.baseUrl}/import`, { kind: "patchloop-feedback-bundle", version: 2, feedback: [feedbackPayload("pl_auth_imp")] });
  assert.equal(importNoToken.status, 401);
  const statusNoToken = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" });
  assert.equal(statusNoToken.status, 401);
  const githubNoToken = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
  assert.equal(githubNoToken.status, 401);
  const deleteNoToken = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(deleteNoToken.status, 401);

  // A wrong token is rejected; the correct bearer token is accepted, for
  // reads and operations alike (curl workflows keep working).
  const badToken = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" }, { Authorization: "Bearer nope" });
  assert.equal(badToken.status, 401);
  const readBearer = await fetch(`${receiver.baseUrl}/feedback.json`, { headers: { Authorization: "Bearer s3cret" } });
  assert.equal(readBearer.status, 200);
  const ok = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" }, { Authorization: "Bearer s3cret" });
  assert.equal(ok.status, 200);
});

test("login form issues a session cookie that unlocks the inbox (no raw token in the browser)", async (t) => {
  const receiver = await startReceiver(t, { RECEIVER_TOKEN: "s3cret" });
  const payload = feedbackPayload("pl_login_1");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  // The login page itself is reachable without credentials.
  const form = await fetch(`${receiver.baseUrl}/login`);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /name="token"/);

  // A wrong token re-renders the form as 401 and sets no cookie.
  const failed = await fetch(`${receiver.baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=nope"
  });
  assert.equal(failed.status, 401);
  assert.equal(failed.headers.get("set-cookie"), null);

  // The correct token redirects to the inbox with an HttpOnly session cookie
  // that is derived (expiry + HMAC) — the raw token never reaches the browser.
  const login = await fetch(`${receiver.baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=s3cret",
    redirect: "manual"
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /^patchloop_session=\d+\.[0-9a-f]{64}; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.doesNotMatch(setCookie, /s3cret/);
  const cookie = setCookie.split(";")[0];

  // The cookie unlocks the inbox page, reads, and operations — the inbox UI's
  // same-origin fetches need no extra wiring.
  const inbox = await fetch(receiver.baseUrl, { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  const inboxHtml = await inbox.text();
  assert.match(inboxHtml, /action="\/logout"/);
  assert.match(inbox.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(inbox.headers.get("x-content-type-options"), "nosniff");
  const read = await fetch(`${receiver.baseUrl}/feedback.json`, { headers: { Cookie: cookie } });
  assert.equal(read.status, 200);
  const status = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" }, { Cookie: cookie });
  assert.equal(status.status, 200);

  // A visit to /login with a valid session bounces back to the inbox.
  const revisit = await fetch(`${receiver.baseUrl}/login`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(revisit.status, 303);
  assert.equal(revisit.headers.get("location"), "/");

  // Tampered and expired cookies are rejected. The expired one carries a valid
  // signature over a past expiry, so only the expiry check can catch it.
  const tampered = await fetch(`${receiver.baseUrl}/feedback.json`, { headers: { Cookie: `${cookie}ff` } });
  assert.equal(tampered.status, 401);
  const pastExpiry = Date.now() - 1000;
  const expiredSignature = crypto.createHmac("sha256", "s3cret").update(String(pastExpiry)).digest("hex");
  const expired = await fetch(`${receiver.baseUrl}/feedback.json`, {
    headers: { Cookie: `patchloop_session=${pastExpiry}.${expiredSignature}` }
  });
  assert.equal(expired.status, 401);

  // Logout clears the cookie and returns to the login form.
  const logout = await fetch(`${receiver.baseUrl}/logout`, { method: "POST", headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");
  assert.match(logout.headers.get("set-cookie"), /^patchloop_session=; Max-Age=0/);
});

test("CORS headers are scoped to the ingest route and honor the allowlist", async (t) => {
  const receiver = await startReceiver(t, { ALLOWED_ORIGINS: "http://demo.example, http://other.example/" });
  assert.match(receiver.logs, /CORS allowlist: http:\/\/demo\.example, http:\/\/other\.example/);

  // Preflight from an allowlisted origin is granted (origin echoed back).
  const allowed = await fetch(`${receiver.baseUrl}/feedback`, { method: "OPTIONS", headers: { Origin: "http://demo.example" } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://demo.example");
  assert.equal(allowed.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(allowed.headers.get("vary"), "Origin");

  // An origin outside the list gets no CORS headers, so the browser blocks the
  // cross-origin POST at the preflight.
  const denied = await fetch(`${receiver.baseUrl}/feedback`, { method: "OPTIONS", headers: { Origin: "http://evil.example" } });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  // Non-ingest endpoints emit no CORS headers at all (same-origin surfaces),
  // and neither does a 405 on the ingest path (only POST + preflight do).
  const inbox = await fetch(receiver.baseUrl, { headers: { Origin: "http://demo.example" } });
  assert.equal(inbox.headers.get("access-control-allow-origin"), null);
  const read = await fetch(`${receiver.baseUrl}/feedback.json`, { headers: { Origin: "http://demo.example" } });
  assert.equal(read.headers.get("access-control-allow-origin"), null);
  const wrongMethod = await fetch(`${receiver.baseUrl}/feedback`, { headers: { Origin: "http://demo.example" } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("access-control-allow-origin"), null);

  // The stored record keeps the provenance signal for triage.
  const fromAllowed = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_cors_ok"), { Origin: "http://demo.example" });
  assert.equal(fromAllowed.status, 201);
  const fromDenied = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_cors_ng"), { Origin: "http://evil.example" });
  assert.equal(fromDenied.status, 403);
  const fromCurl = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_cors_curl"));
  assert.equal(fromCurl.status, 201);

  const stored = await readStoredFeedback(receiver.dbPath);
  const byId = Object.fromEntries(stored.map((item) => [item.id, item.received]));
  assert.deepEqual(byId.pl_cors_ok, { origin: "http://demo.example", originAllowed: true });
  assert.equal(byId.pl_cors_ng, undefined);
  assert.deepEqual(byId.pl_cors_curl, { origin: null, originAllowed: true });
});

test("without an allowlist, ingest CORS stays open and startup warns", async (t) => {
  const receiver = await startReceiver(t);
  assert.match(receiver.logs, /CORS: every origin may POST \/feedback/);

  const preflight = await fetch(`${receiver.baseUrl}/feedback`, { method: "OPTIONS", headers: { Origin: "http://anywhere.example" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

  // Even with CORS open, only the ingest route advertises it.
  const inbox = await fetch(receiver.baseUrl);
  assert.equal(inbox.headers.get("access-control-allow-origin"), null);
});

test("POST /feedback requires a configured ingest key and rejects wrong ones", async (t) => {
  const receiver = await startReceiver(t, { INGEST_KEYS: "key-a, key-b" });
  assert.match(receiver.logs, /ingest auth: enabled \(2 keys\)/);

  // No key / wrong key → rejected before anything is validated or stored.
  const missing = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_key_none"));
  assert.equal(missing.status, 401);
  const wrong = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_key_bad"), { "X-PatchLoop-Ingest-Key": "nope" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await readStoredFeedback(receiver.dbPath), []);

  // Any configured key is accepted.
  const ok = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_key_ok"), { "X-PatchLoop-Ingest-Key": "key-b" });
  assert.equal(ok.status, 201);

  // The preflight must allowlist the key header, or a browser widget carrying
  // a key would be blocked before the POST is ever sent.
  const preflight = await fetch(`${receiver.baseUrl}/feedback`, { method: "OPTIONS", headers: { Origin: "http://demo.example" } });
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-PatchLoop-Ingest-Key/);

  // Other routes are untouched: import stays guarded by RECEIVER_TOKEN (unset
  // here → open), not by ingest keys.
  const imported = await postJson(`${receiver.baseUrl}/import`, { kind: "patchloop-feedback-bundle", version: 2, feedback: [feedbackPayload("pl_key_imp")] });
  assert.equal(imported.status, 201);
});

test("an ingest key bound to a projectId pins the payload's project", async (t) => {
  // projectId binding is config-only (env keys are bare strings), so this test
  // supplies a real config file.
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-ingest-config-"));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const configPath = path.join(configDir, "receiver.config.json");
  await fs.writeFile(configPath, JSON.stringify({ ingestKeys: [{ key: "proj-key", projectId: "proj-a" }] }));
  const receiver = await startReceiver(t, { PATCHLOOP_RECEIVER_CONFIG: configPath });
  const withKey = { "X-PatchLoop-Ingest-Key": "proj-key" };

  // A matching projectId passes; a different one is a spoof (or misconfig).
  const match = await postJson(`${receiver.baseUrl}/feedback`, { ...feedbackPayload("pl_proj_ok"), projectId: "proj-a" }, withKey);
  assert.equal(match.status, 201);
  const spoofed = await postJson(`${receiver.baseUrl}/feedback`, { ...feedbackPayload("pl_proj_spoof"), projectId: "proj-b" }, withKey);
  assert.equal(spoofed.status, 403);
  assert.match(spoofed.body.error, /does not match the ingest key's project/);

  // An omitted projectId is stamped from the key, so the record is attributed.
  const omitted = feedbackPayload("pl_proj_stamped");
  delete omitted.projectId;
  const stamped = await postJson(`${receiver.baseUrl}/feedback`, omitted, withKey);
  assert.equal(stamped.status, 201);

  const stored = await readStoredFeedback(receiver.dbPath);
  const byId = Object.fromEntries(stored.map((item) => [item.id, item.projectId]));
  assert.equal(byId.pl_proj_ok, "proj-a");
  assert.equal(byId.pl_proj_stamped, "proj-a");
  assert.equal(byId.pl_proj_spoof, undefined);
});

test("GET /healthz reports liveness and is exempt from rate limiting", async (t) => {
  const receiver = await startReceiver(t, { RATE_LIMIT_MAX: "1" });

  // Repeated probes (a load balancer polls continuously) all succeed and do
  // not consume the per-client budget…
  for (let i = 0; i < 3; i++) {
    const health = await fetch(`${receiver.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  }
  // …so a real request still gets the full budget (1 allowed, then 429).
  assert.equal((await fetch(`${receiver.baseUrl}/feedback.json`)).status, 200);
  assert.equal((await fetch(`${receiver.baseUrl}/feedback.json`)).status, 429);
});

test("SIGTERM drains: an in-flight request completes and the process exits cleanly", async (t) => {
  const receiver = await startReceiver(t);
  const body = JSON.stringify(feedbackPayload("pl_drain_1"));
  const head = [
    "POST /feedback HTTP/1.1",
    "Host: 127.0.0.1",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "", ""
  ].join("\r\n");

  // Start a request but hold back the tail of the body so it is still in
  // flight when the signal arrives.
  const socket = net.connect(receiver.port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const exited = new Promise((resolve) => receiver.child.once("exit", (code, signal) => resolve({ code, signal })));
  socket.write(head + body.slice(0, 50));
  await new Promise((resolve) => setTimeout(resolve, 50));
  receiver.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.write(body.slice(50));

  const response = await new Promise((resolve, reject) => {
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.once("end", () => resolve(raw));
    socket.once("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 201/);

  // Graceful exit: code 0 (not killed by the signal), store closed last.
  const exit = await exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  const stored = await readStoredFeedback(receiver.dbPath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "pl_drain_1");
});

test("invalid settings warn at startup and the effective values are logged", async (t) => {
  const receiver = await startReceiver(t, { MAX_IMPORT_ITEMS: "0", RATE_LIMIT_MAX: "abc", MAX_BODY_BYTES: "-5", PUBLIC_BASE_URL: "invalid-url" });

  assert.match(receiver.logs, /ignored invalid setting MAX_IMPORT_ITEMS \(env\): "0" — using 500/);
  assert.match(receiver.logs, /ignored invalid setting RATE_LIMIT_MAX \(env\): "abc" — using 120/);
  // Size caps are limits too: 0 / negative would reject every POST.
  assert.match(receiver.logs, /ignored invalid setting MAX_BODY_BYTES \(env\): "-5" — using 3000000/);
  assert.match(receiver.logs, /publicBaseUrl is not a valid URL; screenshot links sent to Slack\/GitHub may be unreachable/);
  // The one-block effective summary shows what the server actually runs with.
  assert.match(receiver.logs, /limits: body=3000000B .*importItems=500/);
  assert.match(receiver.logs, /rate limit: 120 req \/ 60000ms per client/);
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
    child,
    logs,
    port,
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

async function postJson(url, body, headers = {}, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal
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

for (const first of ["slack", "github"]) {
  test(`integration updates preserve each other and triage when ${first} finishes first`, { timeout: 5000 }, async (t) => {
    const slackResponse = Promise.withResolvers();
    const githubResponse = Promise.withResolvers();
    const slack = await startMockGitHub(t, (res) => slackResponse.resolve(res));
    const github = await startMockGitHub(t, (res) => githubResponse.resolve(res));
    const receiver = await startReceiver(t, {
      SLACK_WEBHOOK_URL: slack.baseUrl,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPO: "acme/demo",
      GITHUB_API_BASE: github.baseUrl
    });
    const payload = feedbackPayload(`pl_integrations_${first}`);
    const ingest = postJson(`${receiver.baseUrl}/feedback`, payload);
    const slackRes = await slackResponse.promise;
    const create = postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
    const githubRes = await githubResponse.promise;
    await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" });
    const finishGitHub = () => {
      githubRes.writeHead(201, { "Content-Type": "application/json" });
      githubRes.end(JSON.stringify({ number: 7, html_url: "https://github.com/acme/demo/issues/7" }));
    };
    if (first === "slack") {
      slackRes.end("ok");
      assert.equal((await ingest).status, 201);
      finishGitHub();
      assert.equal((await create).status, 201);
    } else {
      finishGitHub();
      assert.equal((await create).status, 201);
      slackRes.end("ok");
      assert.equal((await ingest).status, 201);
    }
    const [item] = await readStoredFeedback(receiver.dbPath);
    assert.equal(item.status, "accepted");
    assert.equal(item.integrations.slack.status, "sent");
    assert.equal(item.integrations.github.issueNumber, 7);
    assert.equal((await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {})).status, 409);
    assert.equal(github.requests.length, 1);
  });
}

test("a truncated GitHub response fails promptly and releases its operation lock", async (t) => {
  const github = await startMockGitHub(t, (res) => {
    if (github.requests.length === 1) {
      truncateResponse(res);
    } else {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ number: 9, html_url: "https://github.com/acme/demo/issues/9" }));
    }
  });
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token", GITHUB_REPO: "acme/demo", GITHUB_API_BASE: github.baseUrl,
    GITHUB_TIMEOUT_MS: "100"
  });
  const payload = feedbackPayload("pl_truncated_github");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  const failed = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {}, {}, globalThis.AbortSignal.timeout(2000));
  assert.equal(failed.status, 502);
  assert.equal((await readStoredFeedback(receiver.dbPath))[0].integrations.github.status, "failed");
  const retried = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
  assert.equal(retried.status, 201);
  assert.equal(github.requests.length, 2);
});

test("a truncated Slack webhook response does not strand feedback ingestion", async (t) => {
  const slack = await startMockGitHub(t, truncateResponse);
  const receiver = await startReceiver(t, { SLACK_WEBHOOK_URL: slack.baseUrl, SLACK_TIMEOUT_MS: "100" });
  const response = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_truncated_slack"), {}, globalThis.AbortSignal.timeout(2000));
  assert.equal(response.status, 201);
  assert.equal(response.body.slack.status, "failed");
  assert.equal((await readStoredFeedback(receiver.dbPath))[0].integrations.slack.status, "failed");
});

for (const stage of ["init", "upload", "complete"]) {
  test(`a truncated Slack ${stage} response completes ingestion with an image failure`, async (t) => {
    const fakeSlack = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const current = req.url.endsWith("getUploadURLExternal") ? "init"
          : req.url.endsWith("completeUploadExternal") ? "complete" : "upload";
        if (current === stage) {
          truncateResponse(res);
        } else if (current === "init") {
          res.end(JSON.stringify({ ok: true, file_id: "F_TEST", upload_url: `http://127.0.0.1:${fakeSlack.address().port}/upload` }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise((resolve) => fakeSlack.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => fakeSlack.close(resolve)));
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-slack-redirect-"));
    t.after(() => fs.rm(fixtureDir, { recursive: true, force: true }));
    const preload = path.join(fixtureDir, "redirect-slack.cjs");
    // Only the receiver child sees this redirect; no real Slack endpoint is contacted.
    await fs.writeFile(preload, `
      const https = require("node:https");
      const http = require("node:http");
      https.request = (target, options, callback) => {
        const url = new URL(target);
        if (url.hostname !== "slack.com") throw new Error("Unexpected external request in Slack test");
        return http.request("http://127.0.0.1:${fakeSlack.address().port}" + url.pathname, options, callback);
      };
    `);
    const receiver = await startReceiver(t, {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      SLACK_IMAGE_MODE: "upload", SLACK_BOT_TOKEN: "test-token", SLACK_UPLOAD_CHANNEL_ID: "C_TEST",
      SLACK_TIMEOUT_MS: "100"
    });
    const response = await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload(`pl_slack_abort_${stage}`), {}, globalThis.AbortSignal.timeout(2000));
    assert.equal(response.status, 201);
    assert.equal(response.body.slack.status, "failed");
    assert.equal(response.body.slack.image.status, "failed");
  });
}

function truncateResponse(res) {
  res.writeHead(201, { "Content-Type": "application/json", "Content-Length": "1000" });
  res.write("{");
  setTimeout(() => res.destroy(), 20);
}

test("POST /import reports stored-row read failures as server errors before writing", async (t) => {
  const receiver = await startReceiver(t);
  const existing = feedbackPayload("pl_import_corrupt_row");
  assert.equal((await postJson(`${receiver.baseUrl}/feedback`, existing)).status, 201);
  const db = new DatabaseSync(receiver.dbPath);
  try {
    db.prepare("UPDATE feedback SET data = ? WHERE id = ?").run("{", existing.id);
    const files = await fs.readdir(receiver.screenshotDir);
    const response = await postJson(`${receiver.baseUrl}/import`, {
      kind: "patchloop-feedback-bundle", version: 2,
      feedback: [feedbackPayload("pl_import_before_read_failure"), existing]
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.ok, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 1);
    assert.deepEqual(await fs.readdir(receiver.screenshotDir), files);
  } finally {
    db.close();
  }
});

test("import capacity counts new unique ids and skips duplicates before screenshot writes", async (t) => {
  const receiver = await startReceiver(t, {
    MAX_FEEDBACK_COUNT: "2", SCREENSHOT_DISK_MAX_BYTES: String(Buffer.byteLength(testSvg()) * 2)
  });
  const existing = feedbackPayload("pl_capacity_existing");
  const added = feedbackPayload("pl_capacity_new");
  await postJson(`${receiver.baseUrl}/feedback`, existing);
  const response = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle", version: 2, feedback: [existing, added, added]
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.ids, [added.id]);
  assert.deepEqual(response.body.duplicates, [existing.id, added.id]);
  assert.equal(response.body.count, 2);
  assert.equal((await fs.readdir(receiver.screenshotDir)).length, 2);
  const full = await postJson(`${receiver.baseUrl}/import`, {
    kind: "patchloop-feedback-bundle", version: 2, feedback: [existing, added]
  });
  assert.equal(full.status, 409);
  assert.deepEqual(full.body.duplicates, [existing.id, added.id]);
  assert.deepEqual(full.body.failed, []);
  assert.equal((await fs.readdir(receiver.screenshotDir)).length, 2);
});

test("failed screenshot deletion retains the feedback and can be retried", async (t) => {
  const receiver = await startReceiver(t);
  const errors = [];
  receiver.child.stderr.on("data", (chunk) => errors.push(chunk.toString()));
  const payload = feedbackPayload("pl_delete_retry");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  const [item] = await readStoredFeedback(receiver.dbPath);
  const screenshotPath = item.screenshot.path;
  const savedPath = path.join(receiver.tempDir, "saved-screenshot");
  await fs.rename(screenshotPath, savedPath);
  await fs.mkdir(screenshotPath);
  await fs.writeFile(path.join(screenshotPath, "occupied"), "synthetic");
  const failed = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, error: "Unable to delete feedback" });
  assert.equal((await readStoredFeedback(receiver.dbPath)).length, 1);
  await fs.rm(screenshotPath, { recursive: true });
  await fs.rename(savedPath, screenshotPath);
  const retry = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(retry.status, 200);
  assert.equal((await readStoredFeedback(receiver.dbPath)).length, 0);
  await assert.rejects(fs.access(screenshotPath), /ENOENT/);
  const closed = once(receiver.child, "close");
  receiver.child.kill();
  await closed;
  assert.match(errors.join(""), /failed to delete feedback/);
  assert.ok(errors.join("").includes(screenshotPath));
});

test("deleting feedback succeeds when its screenshot is already absent", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_delete_missing_screenshot");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  const [item] = await readStoredFeedback(receiver.dbPath);
  await fs.unlink(item.screenshot.path);
  const response = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await readStoredFeedback(receiver.dbPath)).length, 0);
});

test("GitHub creation prevents deletion until its result is persisted", async (t) => {
  const responseReady = Promise.withResolvers();
  const github = await startMockGitHub(t, (res) => responseReady.resolve(res));
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token", GITHUB_REPO: "acme/demo", GITHUB_API_BASE: github.baseUrl
  });
  const payload = feedbackPayload("pl_delete_during_github");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  const create = postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
  const pending = await responseReady.promise;
  const deletion = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(deletion.status, 409);
  assert.equal((await readStoredFeedback(receiver.dbPath)).length, 1);
  pending.writeHead(201, { "Content-Type": "application/json" });
  pending.end(JSON.stringify({ number: 1, html_url: "https://github.com/acme/demo/issues/1" }));
  assert.equal((await create).status, 201);
  assert.equal((await readStoredFeedback(receiver.dbPath))[0].integrations.github.status, "created");
  const retry = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
  assert.equal(retry.status, 200);
});

test("an in-flight deletion rejects same-id GitHub creation and another deletion", async (t) => {
  const github = await startMockGitHub(t, (res) => res.end("unexpected"));
  const receiver = await startReceiver(t, {
    GITHUB_TOKEN: "test-token", GITHUB_REPO: "acme/demo", GITHUB_API_BASE: github.baseUrl
  });
  const payload = feedbackPayload("pl_github_during_delete");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  const socket = net.connect(receiver.port, "127.0.0.1");
  const raw = await new Promise((resolve, reject) => {
    let response = "";
    socket.once("connect", () => {
      socket.write([
        `DELETE /feedback/${payload.id} HTTP/1.1`, "Host: 127.0.0.1", "", "",
        `POST /feedback/${payload.id}/github-issue HTTP/1.1`, "Host: 127.0.0.1",
        "Content-Type: application/json", "Content-Length: 2", "", "{}",
        `DELETE /feedback/${payload.id} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", "", ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
  assert.deepEqual([...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => Number(match[1])), [200, 409, 409]);
  assert.equal(github.requests.length, 0);
  assert.equal((await readStoredFeedback(receiver.dbPath)).length, 0);
});

test("a database deletion failure can retry after the screenshot was removed", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_delete_database_retry");
  await postJson(`${receiver.baseUrl}/feedback`, payload);
  const [item] = await readStoredFeedback(receiver.dbPath);
  const db = new DatabaseSync(receiver.dbPath);
  try {
    db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON feedback BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END");
    const failed = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
    assert.equal(failed.status, 500);
    assert.equal((await readStoredFeedback(receiver.dbPath)).length, 1);
    await assert.rejects(fs.access(item.screenshot.path), /ENOENT/);
    db.exec("DROP TRIGGER reject_delete");
    const retry = await fetch(`${receiver.baseUrl}/feedback/${payload.id}`, { method: "DELETE" });
    assert.equal(retry.status, 200);
    assert.equal((await readStoredFeedback(receiver.dbPath)).length, 0);
  } finally {
    db.close();
  }
});

test("authenticated inbox screenshots use the current receiver despite a stale public URL", async (t) => {
  const receiver = await startReceiver(t, {
    PUBLIC_BASE_URL: "https://previous.example", RECEIVER_TOKEN: "test-token"
  });
  await postJson(`${receiver.baseUrl}/feedback`, feedbackPayload("pl_current_origin"));
  const headers = { Authorization: "Bearer test-token" };
  const inbox = await fetch(`${receiver.baseUrl}/`, { headers });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.headers.get("content-security-policy").split(";").map((directive) => directive.trim()).find((directive) => directive.startsWith("img-src ")), "img-src 'self'");
  const html = await inbox.text();
  const imagePath = html.match(/<img src="([^"]+)"/)[1];
  assert.match(imagePath, /^\/screenshots\//);
  const image = await fetch(receiver.baseUrl + imagePath, { headers });
  assert.equal(image.status, 200);
  assert.equal(await image.text(), testSvg());
  assert.equal(image.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  const [stored] = await readStoredFeedback(receiver.dbPath);
  assert.match(stored.screenshot.url, /^https:\/\/previous\.example\//);
});
