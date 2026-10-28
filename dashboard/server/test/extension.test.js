/**
 * Tests for the Pi extension's payload, checked against the server's validator.
 *
 * The extension and the server are written independently, so the useful test is the seam
 * between them: build a payload from a fixture session and require the server to accept it.
 * Node's built-in type stripping imports the extension's TypeScript directly, and its only
 * package import is `import type`, which is erased.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { aggregateSession } from "../scanner/aggregate.js";
import { validateIngestPayload } from "../ingest.js";

const extensionPath = join(import.meta.dirname, "..", "..", "..", "pi-extension", "pi-cost.ts");
const { buildPayload, buildSnapshot, postBackground, requestForProtocol } = await import(extensionPath);

const fixturesDir = join(import.meta.dirname, "fixtures");

/**
 * A stand-in for the session manager extensions receive, backed by a fixture file.
 * @param {string} name Fixture file name
 * @returns {object}
 */
const fakeSessionManager = (name) => {
  const filePath = join(fixturesDir, name);
  const entries = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return {
    getEntries: () => entries,
    getHeader: () => entries.find((entry) => entry.type === "session"),
    getSessionId: () => entries.find((entry) => entry.type === "session")?.id,
    getSessionFile: () => filePath,
    getCwd: () => entries.find((entry) => entry.type === "session")?.cwd,
  };
};

test("the extension's totals match the server's own aggregation", () => {
  for (const fixture of ["full-usage.jsonl", "usage-only.jsonl", "forked-zero-cost.jsonl"]) {
    const fromFile = aggregateSession(join(fixturesDir, fixture));
    const snapshot = buildSnapshot(fakeSessionManager(fixture));

    assert.equal(snapshot.sessionId, fromFile.session.sessionId, fixture);
    assert.equal(snapshot.costMicros, fromFile.session.costMicros, `${fixture} cost`);
    assert.equal(snapshot.totalTokens, fromFile.session.totalTokens, `${fixture} tokens`);
    assert.equal(snapshot.entryCount, fromFile.session.entryCount, `${fixture} entries`);
    assert.equal(snapshot.facts.length, fromFile.events.length, `${fixture} fact count`);
  }
});

test("the server accepts the extension's payload", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const payload = buildPayload(snapshot, "agent_settled");
  const result = validateIngestPayload(payload);

  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.reportedBy, "agent_settled");
  assert.equal(payload.totals.costMicros, 19250);
});

test("facts carry the kinds the server's CHECK constraint allows", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const kinds = new Set(snapshot.facts.map((fact) => fact.kind));

  assert.deepEqual(
    [...kinds].sort(),
    ["assistant", "branch_summary", "compaction", "tool_result", "usage"],
  );
});

test("a forked session's parent is reported by session id, not file path", () => {
  const snapshot = buildSnapshot(fakeSessionManager("forked-zero-cost.jsonl"));
  const payload = buildPayload(snapshot, "command");
  const result = validateIngestPayload(payload);

  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(snapshot.parentSessionId, "00000000-0000-4000-8000-000000000000");
});

test("the payload carries no transcript content", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const payload = buildPayload(snapshot, "command");

  const serialized = JSON.stringify(payload);
  for (const forbidden of ["prompt", "transcript", "toolOutput", "content", "text", "apiKey"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `payload must not contain ${forbidden}`);
  }
  assert.ok(serialized.includes("sessionId"), "identifiers are present");
});

test("model attribution falls back to the model in effect", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const unattributedKinds = snapshot.facts.filter((fact) =>
    ["tool_result", "compaction", "branch_summary"].includes(fact.kind),
  );

  for (const fact of unattributedKinds) {
    assert.equal(fact.provider, "anthropic", `${fact.kind} keeps a provider`);
    assert.equal(fact.modelId, "claude-sonnet-4-5", `${fact.kind} keeps a model`);
  }
});

test("an unpriced session is still a valid payload", () => {
  const snapshot = buildSnapshot(fakeSessionManager("forked-zero-cost.jsonl"));
  const result = validateIngestPayload(buildPayload(snapshot, "shutdown"));

  assert.equal(snapshot.costMicros, 0);
  assert.equal(result.ok, true, result.reason ?? "");
});

test("a session with no header falls back to the manager's session id", () => {
  const manager = fakeSessionManager("full-usage.jsonl");
  const headerless = {
    ...manager,
    getEntries: () => manager.getEntries().filter((entry) => entry.type !== "session"),
    getHeader: () => undefined,
  };
  const snapshot = buildSnapshot(headerless);
  const payload = buildPayload(snapshot, "command");
  const result = validateIngestPayload(payload);

  assert.equal(snapshot.sessionId, manager.getSessionId(), "id comes from getSessionId()");
  assert.equal(result.ok, true, result.reason ?? "");
});

test("a session manager with no id at all yields no snapshot", () => {
  const manager = fakeSessionManager("full-usage.jsonl");
  const anonymous = {
    ...manager,
    getEntries: () => manager.getEntries().filter((entry) => entry.type !== "session"),
    getHeader: () => undefined,
    getSessionId: () => undefined,
  };

  assert.equal(buildSnapshot(anonymous), null);
});

test("the request function is chosen by protocol, because node:http cannot speak TLS", () => {
  assert.notEqual(requestForProtocol("http:"), requestForProtocol("https:"));
});

/**
 * Start a server on a random loopback port that captures the first request it receives.
 *
 * The TLS fixture under fixtures/ is a throwaway self-signed certificate for localhost,
 * generated with: openssl req -x509 -newkey rsa:2048 -nodes -days 3650
 *   -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
 * It exists only so the https path can be exercised against a real handshake.
 *
 * @param {"http" | "https"} protocol
 * @returns {Promise<{ url: string, received: Promise<object>, stop: () => void }>}
 */
const startCaptureServer = (protocol) => {
  const fixtureDir = join(import.meta.dirname, "fixtures");

  const handler = (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: 201, applied: true }));
      resolve({ method: req.method, url: req.url, headers: req.headers, body });
    });
  };

  let resolve;
  const received = new Promise((r) => {
    resolve = r;
  });

  const server =
    protocol === "https"
      ? createHttpsServer(
          {
            key: readFileSync(join(fixtureDir, "localhost-key.pem")),
            cert: readFileSync(join(fixtureDir, "localhost-cert.pem")),
          },
          handler,
        )
      : createHttpServer(handler);

  return new Promise((boot) => {
    server.listen(0, "127.0.0.1", () =>
      boot({
        url: `${protocol}://127.0.0.1:${server.address().port}/api/ingest`,
        received,
        stop: () => server.close(),
      }),
    );
  });
};

/**
 * A Config-shaped object for postBackground, with the log pointed at a path that does not
 * exist so a failure in a test cannot write into the developer's Pi directory.
 * @param {string} url
 * @param {string} [token]
 * @returns {object}
 */
const configFor = (url, token = "test-token") => ({
  url,
  autoEnabled: true,
  timeoutMs: 4000,
  minIntervalMs: 0,
  shutdownTimeoutMs: 2000,
  token: token || undefined,
  logFile: join(import.meta.dirname, "tmp-postbackground.log"),
});

test("postBackground delivers a payload over plain HTTP with the token header", async () => {
  const { url, received, stop } = await startCaptureServer("http");
  try {
    const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
    const payload = buildPayload(snapshot, "agent_settled");

    await postBackground(configFor(url), payload);
    const request = await received;

    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/ingest");
    assert.equal(request.headers["x-pi-cost-token"], "test-token");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(JSON.parse(request.body).sessionId, snapshot.sessionId);
  } finally {
    stop();
  }
});

test("postBackground completes a TLS handshake for an https URL", async () => {
  const { url, received, stop } = await startCaptureServer("https");
  const savedReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the fixture certificate is self-signed

  try {
    const snapshot = buildSnapshot(fakeSessionManager("usage-only.jsonl"));
    const payload = buildPayload(snapshot, "shutdown");

    await postBackground(configFor(url), payload);
    const request = await received;

    assert.equal(request.method, "POST", "the request arrived over TLS");
    assert.equal(JSON.parse(request.body).reportedBy, "shutdown");
    assert.equal(request.headers["x-pi-cost-token"], "test-token");
  } finally {
    if (savedReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedReject;
    stop();
  }
});

test("postBackground carries no token header when none is configured", async () => {
  const { url, received, stop } = await startCaptureServer("http");
  try {
    const snapshot = buildSnapshot(fakeSessionManager("forked-zero-cost.jsonl"));
    await postBackground(configFor(url, ""), buildPayload(snapshot, "command"));
    const request = await received;

    assert.equal(request.headers["x-pi-cost-token"], undefined);
  } finally {
    stop();
  }
});
