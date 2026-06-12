"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

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

  const stored = await readStoredFeedback(receiver.storePath);
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
  assert.deepEqual(await readStoredFeedback(receiver.storePath), []);
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

  const stored = await readStoredFeedback(receiver.storePath);
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
  assert.deepEqual(await readStoredFeedback(receiver.storePath), []);
});

test("POST /feedback/:id/status updates triage status and persists it", async (t) => {
  const receiver = await startReceiver(t);
  const payload = feedbackPayload("pl_status_1");
  await postJson(`${receiver.baseUrl}/feedback`, payload);

  const response = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/status`, { status: "accepted" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, id: payload.id, status: "accepted" });

  const stored = await readStoredFeedback(receiver.storePath);
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

  const stored = await readStoredFeedback(receiver.storePath);
  assert.equal(stored[0].integrations.github.status, "created");
  assert.equal(stored[0].integrations.github.issueNumber, 7);

  const again = await postJson(`${receiver.baseUrl}/feedback/${payload.id}/github-issue`, {});
  assert.equal(again.status, 409);
  assert.equal(github.requests.length, 1);
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

  const stored = await readStoredFeedback(receiver.storePath);
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

  const stored = await readStoredFeedback(receiver.storePath);
  assert.equal(stored[0].status, undefined);
});

test("corrupt feedback store is backed up instead of overwritten", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-receiver-test-"));
  const storePath = path.join(tempDir, "feedback.json");
  const corruptContent = '[{"id": "pl_old", "comment": "truncated...';
  await fs.writeFile(storePath, corruptContent);
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  const receiver = await startReceiver(t, { FEEDBACK_STORE_PATH: storePath });
  const payload = feedbackPayload("pl_after_corruption");
  const response = await postJson(`${receiver.baseUrl}/feedback`, payload);
  assert.equal(response.status, 201);

  const stored = await readStoredFeedback(storePath);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, payload.id);

  const entries = await fs.readdir(tempDir);
  const backup = entries.find((name) => name.startsWith("feedback.json.corrupt-"));
  assert.ok(backup, `expected a corrupt backup file, found: ${entries.join(", ")}`);
  assert.equal(await fs.readFile(path.join(tempDir, backup), "utf8"), corruptContent);
  assert.ok(!entries.includes("feedback.json.tmp"), "temp file should not linger after persist");
});

async function startReceiver(t, extraEnv = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "patchloop-receiver-test-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storePath = path.join(tempDir, "feedback.json");
  const screenshotDir = path.join(tempDir, "screenshots");

  const child = spawn(process.execPath, [RECEIVER_PATH], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      FEEDBACK_STORE_PATH: storePath,
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

async function readStoredFeedback(storePath) {
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function feedbackPayload(id) {
  return {
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
