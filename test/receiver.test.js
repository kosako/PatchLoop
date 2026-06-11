"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
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

async function startReceiver(t) {
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
      PATCHLOOP_RECEIVER_CONFIG: path.join(tempDir, "missing-config.json")
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
