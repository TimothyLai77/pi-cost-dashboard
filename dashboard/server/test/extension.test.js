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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { aggregateSession } from "../scanner/aggregate.js";
import { validateIngestPayload, validateTombstonePayload } from "../ingest.js";
import { createApp } from "../index.js";
import { migrateUp, openDatabase } from "../db.js";

const extensionPath = join(import.meta.dirname, "..", "..", "..", "pi-extension", "pi-cost.ts");
const cliPushPath = join(import.meta.dirname, "..", "..", "..", "pi-extension", "cli-push.ts");

// The extension reads its endpoint, its token, and its log path out of the real Pi directory,
// resolved from the home directory when the module loads. Point HOME at an empty temporary one
// first: with nothing saved there, the extension falls back to the environment a test sets, and a
// failed report logs into the temp directory instead of the developer's `pi-cost.log`. Node runs
// each test file in its own process, so the change stays inside this file.
const fakeHome = mkdtempSync(join(tmpdir(), "pi-cost-extension-home-"));
process.env.HOME = fakeHome;
process.on("exit", () => rmSync(fakeHome, { recursive: true, force: true }));

const {
  addPendingReport,
  buildPayload,
  buildSnapshot,
  buildTombstonePayload,
  clearSettings,
  default: createExtension,
  effectiveConfig,
  maskSecret,
  MAX_PENDING_REPORTS,
  PENDING_GIVE_UP_AFTER,
  postBackground,
  readPendingReports,
  readSettings,
  requestForProtocol,
  resolveSettingsAction,
  runSettingsAction,
  validateEndpoint,
  worthRetrying,
  writePendingReports,
  writeSettings,
} = await import(extensionPath);

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
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.reportedBy, "agent_settled");
  assert.equal(payload.totals.costMicros, 19250);
});

test("the extension reports the cost of a call in the four parts it bills", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const payload = buildPayload(snapshot, "agent_settled");

  // The parts come from usage.cost, which Pi writes next to the total, so the split the
  // dashboard shows is the split the provider charged.
  assert.deepEqual(
    [
      payload.totals.costInputMicros,
      payload.totals.costOutputMicros,
      payload.totals.costCacheReadMicros,
      payload.totals.costCacheWriteMicros,
    ],
    [276, 507, 17967, 500],
  );

  const parts =
    payload.totals.costInputMicros +
    payload.totals.costOutputMicros +
    payload.totals.costCacheReadMicros +
    payload.totals.costCacheWriteMicros;
  assert.equal(parts, payload.totals.costMicros, "the reported parts add up to the reported whole");

  for (const event of payload.events) {
    const eventParts =
      event.costInputMicros + event.costOutputMicros + event.costCacheReadMicros + event.costCacheWriteMicros;
    assert.equal(eventParts, event.costMicros, `${event.entryId} parts add up to its cost`);
  }
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
  pendingFile: join(import.meta.dirname, "tmp-postbackground-pending.json"),
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

/* ── Which run modes may report on their own ─────────────────────────────────── */

/**
 * Install the extension into a stand-in Pi and hand back the handlers it registered.
 *
 * The automatic report lives inside a hook handler, so testing it means running the real
 * extension factory. `config` is read at install time, so each install is a clean session: its
 * own throttle clock, its own in-flight flag, and the endpoint currently in the environment.
 *
 * @returns {Map<string, Function>} the handlers, keyed by event name
 */
const installExtension = () => {
  const handlers = new Map();

  createExtension({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
  });

  return handlers;
};

/**
 * Settle an agent in one run mode and report what reached the sink.
 *
 * @param {string} mode The `ctx.mode` Pi reports for this run
 * @param {Promise<object>} received Resolves with the first request the sink captured
 * @returns {Promise<object | null>} the captured request, null when nothing was sent
 */
const settleInMode = async (mode, received) => {
  const handlers = installExtension();

  // The settled handler reads the run mode and the session manager, and nothing else.
  await handlers.get("agent_settled")(undefined, {
    mode,
    sessionManager: fakeSessionManager("full-usage.jsonl"),
  });

  // The report is deliberately not awaited, so give the request a moment to arrive.
  const quietFor = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      timer.unref();
    });

  const request = await Promise.race([received, quietFor(400)]);
  return request ? { method: request.method, url: request.url, payload: JSON.parse(request.body) } : null;
};

test("settled reports run in tui and rpc, and stay silent in print and JSON", async () => {
  const saved = {
    url: process.env.PI_COST_URL,
    interval: process.env.PI_COST_MIN_INTERVAL_MS,
    incognito: process.env.PI_COST_INCOGNITO,
  };
  process.env.PI_COST_MIN_INTERVAL_MS = "1";
  delete process.env.PI_COST_URL;
  delete process.env.PI_COST_INCOGNITO;

  const reported = {};
  try {
    // One sink and one install per mode: the throttle and the in-flight coalescing are per
    // session, and the modes must not shadow each other's result.
    for (const mode of ["tui", "rpc", "print", "json"]) {
      const { url, received, stop } = await startCaptureServer("http");
      process.env.PI_COST_URL = url;
      try {
        reported[mode] = await settleInMode(mode, received);
      } finally {
        stop();
      }
    }
  } finally {
    if (saved.url === undefined) delete process.env.PI_COST_URL;
    else process.env.PI_COST_URL = saved.url;
    if (saved.interval === undefined) delete process.env.PI_COST_MIN_INTERVAL_MS;
    else process.env.PI_COST_MIN_INTERVAL_MS = saved.interval;
    if (saved.incognito === undefined) delete process.env.PI_COST_INCOGNITO;
    else process.env.PI_COST_INCOGNITO = saved.incognito;
  }

  const sessionId = buildSnapshot(fakeSessionManager("full-usage.jsonl")).sessionId;

  for (const mode of ["tui", "rpc"]) {
    assert.ok(reported[mode], `${mode} reports while the session is still running`);
    assert.equal(reported[mode].method, "POST", `${mode} pushes to the ingest endpoint`);
    assert.equal(reported[mode].payload.sessionId, sessionId, `${mode} reports this session`);
    assert.equal(reported[mode].payload.reportedBy, "agent_settled", `${mode} says what woke it`);

    const accepted = validateIngestPayload(reported[mode].payload);
    assert.equal(accepted.ok, true, `${mode} payload: ${accepted.reason ?? "accepted"}`);
  }

  // A print or JSON run cannot exit while a request is outstanding, and its session file is on
  // disk for the scanner either way, so those two modes stay quiet.
  assert.equal(reported.print, null, "a print run sends nothing");
  assert.equal(reported.json, null, "a JSON run sends nothing");
});

/* ── Settings saved from the TUI ─────────────────────────────────────────────── */

/**
 * A settings file in a temporary directory, so tests never touch the real Pi directory.
 * @param {string} [contents] Initial file contents
 * @returns {{ file: string, cleanup: () => void }}
 */
const tempSettingsFile = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-settings-"));
  const file = join(dir, "pi-cost.json");
  if (contents !== undefined) writeFileSync(file, contents, { mode: 0o600 });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * A stand-in for Pi's dialog UI that records notifications and answers prompts from a script.
 * @param {{ input?: string[], confirm?: boolean }} answers
 * @returns {{ ui: object, notices: { message: string, level: string }[] }}
 */
const stubUi = ({ input = [], confirm = true } = {}) => {
  const notices = [];
  const prompts = [...input];
  return {
    notices,
    ui: {
      select: async (_title, options) => options[0],
      input: async () => prompts.shift() ?? "",
      confirm: async () => confirm,
      notify: (message, level = "info") => notices.push({ message, level }),
    },
  };
};

test("saved settings round-trip and the file is owner-only", () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    const saved = writeSettings({ url: "https://pi-cost.example/api/ingest", token: "secret-token", auto: false }, file);
    assert.equal(saved.url, "https://pi-cost.example/api/ingest");
    assert.equal(readSettings(file).token, "secret-token");
    assert.equal(readSettings(file).auto, false);

    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, "the token is not readable by other users");

    // Merging keeps keys that a later action does not touch.
    writeSettings({ auto: true }, file);
    assert.equal(readSettings(file).url, "https://pi-cost.example/api/ingest");
    assert.equal(readSettings(file).auto, true);
  } finally {
    cleanup();
  }
});

test("a missing, corrupt, or cleared settings file reads as nothing saved", () => {
  const missing = tempSettingsFile();
  const corrupt = tempSettingsFile("{ this is not json");
  const array = tempSettingsFile("[1,2,3]");
  try {
    assert.equal(readSettings(missing.file), null);
    assert.equal(readSettings(corrupt.file), null, "a bad manual edit must not crash a session");
    assert.equal(readSettings(array.file), null);

    writeSettings({ url: "https://a.example/api/ingest" }, missing.file);
    assert.equal(clearSettings(missing.file), true);
    assert.equal(readSettings(missing.file), null);
    assert.equal(clearSettings(missing.file), true, "clearing an absent file is success");
  } finally {
    [missing, corrupt, array].forEach((entry) => entry.cleanup());
  }
});

test("saved settings win over the environment, key by key", () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    writeSettings({ url: "https://saved.example/api/ingest", token: "saved-token" }, file);
    const config = effectiveConfig(readSettings(file), {
      PI_COST_URL: "https://env.example/api/ingest",
      PI_COST_TOKEN: "env-token",
      PI_COST_AUTO: "0",
    });

    assert.equal(config.url, "https://saved.example/api/ingest");
    assert.equal(config.token, "saved-token");
    // auto is not saved, so the environment still applies to it.
    assert.equal(config.autoEnabled, false);
    assert.equal(config.source, "file");
  } finally {
    cleanup();
  }
});

test("an empty saved token means no token, not the environment's", () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    writeSettings({ url: "https://saved.example/api/ingest", token: "" }, file);
    const config = effectiveConfig(readSettings(file), { PI_COST_TOKEN: "env-token" });

    assert.equal(config.token, undefined, "turning a token off is a saved choice");
  } finally {
    cleanup();
  }
});

test("no endpoint anywhere leaves the extension disabled", () => {
  assert.equal(effectiveConfig(null, {}), null);
  const fromEnv = effectiveConfig(null, { PI_COST_URL: "http://127.0.0.1:4870/api/ingest" });
  assert.equal(fromEnv.url, "http://127.0.0.1:4870/api/ingest");
  assert.equal(fromEnv.source, "env");
});

test("endpoint validation accepts real ingest URLs and rejects the shapes that cannot work", () => {
  assert.equal(validateEndpoint("https://pi-cost.catfast.net/api/ingest").ok, true);
  assert.equal(validateEndpoint("  http://192.168.1.8:4870/api/ingest  ").url, "http://192.168.1.8:4870/api/ingest");
  assert.equal(validateEndpoint("").ok, false);
  assert.equal(validateEndpoint("not a url").ok, false);
  assert.equal(validateEndpoint("ftp://host/api/ingest").ok, false, "only http and https");
  assert.equal(validateEndpoint("https://host.example").ok, false, "the host alone is not an endpoint");

  const offPath = validateEndpoint("https://host.example/ingest");
  assert.equal(offPath.ok, true, "an unusual path is saved, with a note");
  assert.ok(offPath.message.includes("/api/ingest"));
});

test("tokens are shown masked", () => {
  assert.equal(maskSecret(undefined), "none");
  assert.equal(maskSecret("short"), "•••• (5 chars)");
  const masked = maskSecret("dda4b1abcf46806b49322307f4a4aaaf");
  assert.equal(masked, "dda4…aaaf (32 chars)");
  assert.equal(masked.includes("b1abcf46806b"), false);
});

test("subcommands skip the menu and unknown words do not", () => {
  assert.equal(resolveSettingsAction("url").key, "url");
  assert.equal(resolveSettingsAction("  TOKEN extra").key, "token");
  assert.equal(resolveSettingsAction(""), null);
  assert.equal(resolveSettingsAction("explode"), null);
});

test("the url action validates, saves, and re-reads settings", async () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    const { ui, notices } = stubUi({ input: ["https://pi-cost.example/api/ingest"] });
    let current = null;
    const refresh = () => {
      current = effectiveConfig(readSettings(file), {});
    };

    await runSettingsAction("url", { ui, refresh, current: () => current, settingsFile: file });

    assert.equal(readSettings(file).url, "https://pi-cost.example/api/ingest");
    assert.equal(current.url, "https://pi-cost.example/api/ingest", "refresh ran after the write");
    assert.ok(notices.at(-1).message.includes("Endpoint saved"));
  } finally {
    cleanup();
  }
});

test("the url action refuses a bad endpoint and changes nothing", async () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    const { ui, notices } = stubUi({ input: ["ftp://host/api/ingest"] });
    await runSettingsAction("url", { ui, refresh: () => {}, current: () => null, settingsFile: file });

    assert.equal(readSettings(file), null, "nothing was saved");
    assert.equal(notices.at(-1).level, "error");
    assert.ok(notices.at(-1).message.includes("http"));
  } finally {
    cleanup();
  }
});

test("the token action saves masked and clearing it is remembered", async () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    const { ui, notices } = stubUi({ input: ["a-very-secret-token-1234567890"] });
    await runSettingsAction("token", { ui, refresh: () => {}, current: () => null, settingsFile: file });

    assert.equal(readSettings(file).token, "a-very-secret-token-1234567890");
    assert.equal(notices.at(-1).message.includes("a-very-secret-token-1234567890"), false, "the secret is not echoed");
    assert.ok(notices.at(-1).message.includes("Token saved"));

    const cleared = stubUi({ input: [""] });
    await runSettingsAction("token", {
      ui: cleared.ui,
      refresh: () => {},
      current: () => effectiveConfig(readSettings(file), {}),
      settingsFile: file,
    });
    assert.equal(readSettings(file).token, "");
    assert.ok(cleared.notices.at(-1).message.includes("Token cleared"));
  } finally {
    cleanup();
  }
});

test("the auto action toggles a configured endpoint off and back on", async () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    writeSettings({ url: "https://x.example/api/ingest" }, file);
    const current = () => effectiveConfig(readSettings(file), {});
    const { ui, notices } = stubUi();

    await runSettingsAction("auto", { ui, refresh: () => {}, current, settingsFile: file });
    assert.equal(readSettings(file).auto, false);
    assert.ok(notices.at(-1).message.includes("off"));
    assert.equal(readSettings(file).url, "https://x.example/api/ingest", "the endpoint is untouched");

    await runSettingsAction("auto", { ui, refresh: () => {}, current, settingsFile: file });
    assert.equal(readSettings(file).auto, true);
    assert.ok(notices.at(-1).message.includes("on"));
  } finally {
    cleanup();
  }
});

test("the auto action refuses to toggle when nothing is configured", async () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    const { ui, notices } = stubUi();
    await runSettingsAction("auto", { ui, refresh: () => {}, current: () => null, settingsFile: file });

    assert.equal(readSettings(file), null, "no setting is saved for an endpoint that does not exist");
    assert.ok(notices.at(-1).message.includes("No endpoint configured"));
  } finally {
    cleanup();
  }
});

test("show reports what is configured, and says so when nothing is", async () => {
  const { file, cleanup } = tempSettingsFile();
  try {
    const empty = stubUi();
    await runSettingsAction("show", { ui: empty.ui, refresh: () => {}, current: () => null, settingsFile: file });
    assert.ok(empty.notices.at(-1).message.includes("no endpoint saved"));

    writeSettings({ url: "https://pi-cost.example/api/ingest", token: "0123456789abcdef" }, file);
    const shown = stubUi();
    await runSettingsAction("show", {
      ui: shown.ui,
      refresh: () => {},
      current: () => effectiveConfig(readSettings(file), {}),
      settingsFile: file,
    });

    const message = shown.notices.at(-1).message;
    assert.ok(message.includes("https://pi-cost.example/api/ingest"));
    assert.ok(message.includes("saved settings"));
    assert.equal(message.includes("0123456789abcdef"), false, "show masks the token");
  } finally {
    cleanup();
  }
});

test("clear deletes the file only when confirmed", async () => {
  const yes = tempSettingsFile();
  const no = tempSettingsFile();
  try {
    writeSettings({ url: "https://x.example/api/ingest" }, yes.file);
    writeSettings({ url: "https://x.example/api/ingest" }, no.file);

    const confirmed = stubUi({ confirm: true });
    await runSettingsAction("clear", { ui: confirmed.ui, refresh: () => {}, current: () => null, settingsFile: yes.file });
    assert.equal(readSettings(yes.file), null);

    const declined = stubUi({ confirm: false });
    await runSettingsAction("clear", { ui: declined.ui, refresh: () => {}, current: () => null, settingsFile: no.file });
    assert.equal(readSettings(no.file).url, "https://x.example/api/ingest", "declined means unchanged");
  } finally {
    yes.cleanup();
    no.cleanup();
  }
});

/**
 * Run the real Express app on a random loopback port, with a token configured the way the
 * middleware reads it (from the environment, at request time).
 * @param {string} token
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
const startAppServer = async (token) => {
  const savedToken = process.env.PI_COST_TOKEN;
  process.env.PI_COST_TOKEN = token;

  const db = openDatabase(":memory:");
  migrateUp(db);
  const server = createHttpServer(createApp(db, { sessionsDir: "/tmp/pi-cost-none", rescan: () => ({}) }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  return {
    url: `http://127.0.0.1:${server.address().port}/api/ingest`,
    stop: async () => {
      await new Promise((done) => server.close(done));
      db.close();
      if (savedToken === undefined) delete process.env.PI_COST_TOKEN;
      else process.env.PI_COST_TOKEN = savedToken;
    },
  };
};

test("the test action reports reachability and the token verdict against the real app", async () => {
  const { url, stop } = await startAppServer("probe-token");
  try {
    const good = effectiveConfig({ url, token: "probe-token" }, {});
    const { ui, notices } = stubUi();
    await runSettingsAction("test", { ui, refresh: () => {}, current: () => good, settingsFile: "unused" });

    const goodMessage = notices.at(-1).message;
    assert.ok(goodMessage.includes("Reachable"), goodMessage);
    assert.ok(goodMessage.includes("Token accepted"), goodMessage);

    const bad = effectiveConfig({ url, token: "not-the-token" }, {});
    const badUi = stubUi();
    await runSettingsAction("test", { ui: badUi.ui, refresh: () => {}, current: () => bad, settingsFile: "unused" });

    const badMessage = badUi.notices.at(-1).message;
    assert.ok(badMessage.includes("Reachable"), badMessage);
    assert.ok(badMessage.includes("Token rejected (401)"), badMessage);
    assert.equal(badUi.notices.at(-1).level, "warning", "reachable with a bad secret is a warning, not success");
  } finally {
    await stop();
  }
});

test("the test action reports an unreachable endpoint as an error", async () => {
  const config = effectiveConfig({ url: "http://127.0.0.1:1/api/ingest", token: "t" }, {});
  const { ui, notices } = stubUi();
  await runSettingsAction("test", { ui, refresh: () => {}, current: () => config, settingsFile: "unused" });

  assert.equal(notices.at(-1).level, "error");
  assert.ok(notices.at(-1).message.includes("Not reachable"));
});

test("the server accepts the extension's tombstone payload", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const payload = buildTombstonePayload(snapshot.sessionId, true);

  assert.equal(payload.schemaVersion, 3);
  assert.deepEqual(Object.keys(payload).sort(), ["incognito", "schemaVersion", "sessionId"]);

  const result = validateTombstonePayload(payload);
  assert.equal(result.ok, true, result.reason ?? "");
});

test("incognitoDefault: saved setting wins over environment, environment over default", () => {
  const url = "https://host.example/api/ingest";

  const fromEnv = effectiveConfig({ url }, { PI_COST_INCOGNITO: "1" });
  assert.equal(fromEnv.incognitoDefault, true, "PI_COST_INCOGNITO=1 seeds new sessions incognito");

  const plain = effectiveConfig({ url }, {});
  assert.equal(plain.incognitoDefault, false, "default is visible sessions");

  const savedFalse = effectiveConfig({ url, incognitoByDefault: false }, { PI_COST_INCOGNITO: "1" });
  assert.equal(savedFalse.incognitoDefault, false, "the saved choice beats the environment");

  const savedTrue = effectiveConfig({ url, incognitoByDefault: true }, {});
  assert.equal(savedTrue.incognitoDefault, true, "and so does a saved true");
});

test("a tombstone round trip against the real app purges, blocks, and lifts", async () => {
  const { url, stop } = await startAppServer("incognito-token");
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const headers = { "content-type": "application/json", "x-pi-cost-token": "incognito-token" };

  const send = async (body) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  try {
    // The session reports, then goes incognito mid-session.
    const reported = await send(buildPayload(snapshot, "agent_settled"));
    assert.equal(reported.status, 201);

    const tombstoned = await send(buildTombstonePayload(snapshot.sessionId, true));
    assert.equal(tombstoned.status, 200);
    assert.equal(tombstoned.body.purged, 1, "the stored rows are removed");

    // Later reports of the same session are refused as incognito, not stale.
    const blocked = await send(buildPayload(snapshot, "shutdown"));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "incognito");

    // Lifting the tombstone lets the same snapshot land again.
    const lifted = await send(buildTombstonePayload(snapshot.sessionId, false));
    assert.equal(lifted.status, 200);
    assert.equal(lifted.body.incognito, false);

    const resumed = await send(buildPayload(snapshot, "agent_settled"));
    assert.equal(resumed.status, 201);
    assert.equal(resumed.body.applied, true);
  } finally {
    await stop();
  }
});

/* ── Reports the server never took ───────────────────────────────────────────── */

/**
 * Run a block with the extension's home-derived paths pointed at a throwaway directory.
 *
 * The endpoint, the log, and the retry queue all hang off the Pi directory, which is resolved
 * when a config is read rather than when the module loads, so HOME can be swapped back in for one
 * test. Without this, a test that fails a report would write into the developer's own log.
 *
 * @param {(home: string) => Promise<void>} run
 * @returns {Promise<void>}
 */
const withTempHome = async (run) => {
  const home = mkdtempSync(join(tmpdir(), "pi-cost-extension-home-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    await run(home);
  } finally {
    process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
};

/** @returns {Promise<number>} a loopback port with nothing listening on it */
const closedPort = async () => {
  const probe = createHttpServer(() => {});
  await new Promise((boot) => probe.listen(0, "127.0.0.1", boot));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
};

/**
 * Poll until `check` is true, because a report that is deliberately not awaited has to fail on
 * its own schedule.
 *
 * @param {() => boolean} check
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
const until = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((sleep) => setTimeout(sleep, 25));
  }
  return check();
};

/**
 * A server that answers every request with a fixed status and body, and records what it was asked
 * so a test can tell which reports actually arrived.
 * @param {number} status
 * @param {string | object} body
 * @returns {Promise<{ url: string, requests: any[], stop: () => Promise<void> }>}
 */
const startAnsweringServer = async (status, body) => {
  /** @type {any[]} */
  const requests = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        requests.push(null);
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((boot) => server.listen(0, "127.0.0.1", boot));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/ingest`,
    requests,
    stop: () => new Promise((done) => server.close(done)),
  };
};

/**
 * Put the environment a report needs in place and restore it afterwards.
 * @param {{ url?: string, interval?: string }} values
 * @param {() => Promise<void>} run
 * @returns {Promise<void>}
 */
const withReportEnv = async (values, run) => {
  const keys = Object.keys(values);
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    await run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

// Bounded so a report that never settles fails this test instead of hanging the whole file.
test("postBackground says what the server answered, so a failure can be kept", { timeout: 15000 }, async () => {
  /**
   * @param {number} status
   * @param {string | object} body
   * @returns {Promise<object>}
   */
  const send = async (status, body) => {
    const { url, stop } = await startAnsweringServer(status, body);
    try {
      return await postBackground(configFor(url), { sessionId: "session-under-test" });
    } finally {
      await stop();
    }
  };

  assert.deepEqual(await send(201, { ok: true, applied: true }), {
    ok: true,
    status: 201,
    applied: true,
    error: null,
  });

  // A snapshot refused as stale is not an error: the server holds better numbers, so nothing is
  // owed. Reading `applied` is what stops the queue retrying a report that already lost.
  const stale = await send(200, { ok: true, applied: false });
  assert.equal(stale.ok, true, "the server answered successfully");
  assert.equal(stale.applied, false, "and kept the newer row");

  const gateway = await send(502, "<html>Bad Gateway</html>");
  assert.equal(gateway.ok, false);
  assert.equal(gateway.status, 502);

  const refused = await send(400, { error: "entryCount must be a number" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.equal(
    refused.error,
    "entryCount must be a number",
    "the server's reason survives, so a log line can repeat it instead of a bare status",
  );

  // A tombstoned session is refused with 409 `incognito`. Losing that word is how a correct
  // refusal ends up looking like a broken endpoint.
  const tombstoned = await send(409, { ok: false, error: "incognito", sessionId: "session-under-test" });
  assert.equal(tombstoned.ok, false);
  assert.equal(tombstoned.status, 409);
  assert.equal(tombstoned.error, "incognito");
});

test("a report nobody answered is worth retrying, one read and refused is not", async () => {
  const outcome = await postBackground(configFor("not a url"), { sessionId: "session-under-test" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, null, "no status, because there was no server");
  assert.match(outcome.error, /not a valid endpoint/);

  assert.equal(worthRetrying(null), true);
  assert.equal(worthRetrying(502), true, "a server having a bad day may recover");
  assert.equal(worthRetrying(400), false, "the same bytes get the same answer");
  assert.equal(worthRetrying(409), false, "an incognito or conflicting row will not change its mind");
});

test("the queue keeps one entry per session, counts attempts, and then gives up", () => {
  const first = addPendingReport([], { sessionId: "a", entryCount: 1 }, "2026-11-08T00:00:00.000Z");
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].attempts, 1);
  assert.deepEqual(first.gaveUp, []);

  // The same session settles again and fails again: the newest snapshot replaces the queued one,
  // and the attempt count follows the session, which is the thing not getting through.
  const second = addPendingReport(first.entries, { sessionId: "a", entryCount: 9 }, "2026-11-08T00:01:00.000Z");
  assert.equal(second.entries.length, 1, "still one entry for the session");
  assert.equal(second.entries[0].payload.entryCount, 9, "the newest snapshot is the one kept");
  assert.equal(second.entries[0].attempts, 2);

  let queue = second.entries;
  const gaveUp = [];
  for (let attempt = 3; attempt <= PENDING_GIVE_UP_AFTER; attempt += 1) {
    const next = addPendingReport(queue, { sessionId: "a", entryCount: 10 }, "2026-11-08T00:02:00.000Z");
    queue = next.entries;
    gaveUp.push(...next.gaveUp);
  }

  assert.deepEqual(queue, [], "an exhausted session leaves the queue");
  assert.equal(gaveUp.length, 1, "and it is reported exactly once, so it can be logged");
  assert.equal(gaveUp[0].attempts, PENDING_GIVE_UP_AFTER);
});

test("the queue file is capped, owner-only, and gone once empty", () => {
  const file = join(tmpdir(), `pi-cost-pending-${process.pid}-${Date.now()}.json`);
  try {
    const crowded = Array.from({ length: MAX_PENDING_REPORTS + 5 }, (unused, index) => ({
      sessionId: `session-${index}`,
      attempts: 1,
      updatedAt: "2026-11-08T00:00:00.000Z",
      payload: { sessionId: `session-${index}` },
    }));
    const { entries } = addPendingReport(crowded, { sessionId: "newest" }, "2026-11-08T00:00:01.000Z");
    assert.equal(entries.length, MAX_PENDING_REPORTS, "the least recently touched make room");
    assert.equal(entries[entries.length - 1].sessionId, "newest");

    assert.equal(writePendingReports(file, entries), true);
    assert.equal(statSync(file).mode & 0o777, 0o600, "the queue holds spending, like the token file");
    assert.equal(readPendingReports(file).length, MAX_PENDING_REPORTS, "and reads back");

    assert.equal(writePendingReports(file, []), true);
    assert.equal(existsSync(file), false, "an empty queue leaves no file behind");

    writeFileSync(file, "{ not json");
    assert.deepEqual(readPendingReports(file), [], "a corrupt queue reads as empty rather than throwing");
  } finally {
    rmSync(file, { force: true });
  }
});

test("a settled report the server never took is queued on the Pi box", async () => {
  const url = `http://127.0.0.1:${await closedPort()}/api/ingest`;

  await withReportEnv({ PI_COST_URL: url, PI_COST_MIN_INTERVAL_MS: "1" }, async () => {
    await withTempHome(async (home) => {
      const pendingFile = join(home, ".pi", "agent", "extensions", "pi-cost-pending.json");
      const handlers = installExtension();

      await handlers.get("agent_settled")(undefined, {
        mode: "rpc",
        sessionManager: fakeSessionManager("full-usage.jsonl"),
      });

      assert.ok(
        await until(() => existsSync(pendingFile)),
        "a report that reached nobody leaves a queue file",
      );
      const [entry] = readPendingReports(pendingFile);
      assert.equal(
        entry.sessionId,
        buildSnapshot(fakeSessionManager("full-usage.jsonl")).sessionId,
        "the queued report is this session's",
      );
      assert.equal(entry.attempts, 1, "the prompt that failed counts as the first attempt");
      assert.equal(entry.payload.reportedBy, "agent_settled");
    });
  });
});

test("a report the server read and refused is not queued", async () => {
  const { url, stop } = await startAnsweringServer(400, { error: "entryCount must be a number" });

  await withReportEnv({ PI_COST_URL: url, PI_COST_MIN_INTERVAL_MS: "1" }, async () => {
    try {
      await withTempHome(async (home) => {
        const pendingFile = join(home, ".pi", "agent", "extensions", "pi-cost-pending.json");
        const handlers = installExtension();

        await handlers.get("agent_settled")(undefined, {
          mode: "rpc",
          sessionManager: fakeSessionManager("full-usage.jsonl"),
        });

        await new Promise((wait) => setTimeout(wait, 400));
        assert.equal(existsSync(pendingFile), false, "the same report gets the same answer twice");
      });
    } finally {
      await stop();
    }
  });
});

// Bounded so a replay that never fires fails with a message instead of hanging the file.
test("a queued report goes out on a later settle and leaves the queue", { timeout: 20000 }, async () => {
  const deadUrl = `http://127.0.0.1:${await closedPort()}/api/ingest`;
  const recovered = await startAnsweringServer(201, { ok: true, applied: true });

  try {
    await withReportEnv({ PI_COST_URL: deadUrl, PI_COST_MIN_INTERVAL_MS: "1" }, async () => {
      await withTempHome(async (home) => {
        const pendingFile = join(home, ".pi", "agent", "extensions", "pi-cost-pending.json");
        const handlers = installExtension();

        await handlers.get("agent_settled")(undefined, {
          mode: "rpc",
          sessionManager: fakeSessionManager("full-usage.jsonl"),
        });
        assert.ok(await until(() => existsSync(pendingFile)), "the first session's report is queued");

        // The endpoint comes back, and a later session settles. A later session is a fresh
        // install in reality — Pi builds the extension per process — and the queue file on disk
        // is what carries the report between them. Its own report goes out as usual; the queued
        // one rides along on the same settle rather than waiting for a restart nobody is going
        // to do just to sync numbers.
        process.env.PI_COST_URL = recovered.url;
        const laterHandlers = installExtension();
        await laterHandlers.get("agent_settled")(undefined, {
          mode: "rpc",
          sessionManager: fakeSessionManager("usage-only.jsonl"),
        });

        assert.ok(await until(() => !existsSync(pendingFile)), "the recovered report leaves the queue");
        const queuedSessionId = buildSnapshot(fakeSessionManager("full-usage.jsonl")).sessionId;
        assert.ok(
          recovered.requests.map((request) => request.sessionId).includes(queuedSessionId),
          `the queued report should have reached the server, got ${JSON.stringify(recovered.requests.map((r) => r.sessionId))}`,
        );
      });
    });
  } finally {
    await recovered.stop();
  }
});

test("a queued report the server read and refused is dropped, not retried", { timeout: 20000 }, async () => {
  const deadUrl = `http://127.0.0.1:${await closedPort()}/api/ingest`;
  const refusing = await startAnsweringServer(400, { error: "entryCount must be a number" });

  try {
    await withReportEnv({ PI_COST_URL: deadUrl, PI_COST_MIN_INTERVAL_MS: "1" }, async () => {
      await withTempHome(async (home) => {
        const pendingFile = join(home, ".pi", "agent", "extensions", "pi-cost-pending.json");
        const handlers = installExtension();

        await handlers.get("agent_settled")(undefined, {
          mode: "rpc",
          sessionManager: fakeSessionManager("full-usage.jsonl"),
        });
        assert.ok(await until(() => existsSync(pendingFile)), "a report that reached nobody is queued");

        process.env.PI_COST_URL = refusing.url;
        const laterHandlers = installExtension();
        await laterHandlers.get("agent_settled")(undefined, {
          mode: "rpc",
          sessionManager: fakeSessionManager("usage-only.jsonl"),
        });

        assert.ok(
          await until(() => !existsSync(pendingFile)),
          "a replay the server read and refused leaves the queue: the same bytes get the same answer",
        );
      });
    });
  } finally {
    await refusing.stop();
  }
});

test("a report that never lands stops being retried after five attempts", { timeout: 30000 }, async () => {
  const deadUrl = `http://127.0.0.1:${await closedPort()}/api/ingest`;

  await withReportEnv({ PI_COST_URL: deadUrl, PI_COST_MIN_INTERVAL_MS: "1" }, async () => {
    await withTempHome(async (home) => {
      const pendingFile = join(home, ".pi", "agent", "extensions", "pi-cost-pending.json");
      const logFile = join(home, ".pi", "agent", "extensions", "pi-cost.log");
      const handlers = installExtension();

      const settle = async () => {
        await handlers.get("agent_settled")(undefined, {
          mode: "rpc",
          sessionManager: fakeSessionManager("full-usage.jsonl"),
        });
        // Past the one-millisecond report floor, and enough time for the unawaited send to fail.
        await new Promise((wait) => setTimeout(wait, 200));
      };

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await settle();
      }

      assert.equal(existsSync(pendingFile), false, "an exhausted report stops being carried");
      const log = readFileSync(logFile, "utf8");
      assert.match(log, /gave up on session .* after 5 attempts/, "and says so where a user can find it");
    });
  });
});

// The CLI runs as its own process, the way it is used: on a Pi box, with no shared database.
// What this proves is the second client of the ingest contract — files on disk in, rows in the
// dashboard out — which the payload tests above only cover for the live extension.

/**
 * Run `cli-push.ts` as its own process.
 *
 * The cost-dashboard endpoint and token are cleared from the inherited environment so a
 * developer's own `PI_COST_URL` cannot quietly decide what a test saw.
 *
 * @param {{ args: string[], home?: string, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
const runCliPush = ({ args, home = fakeHome, env = {} }) =>
  new Promise((done) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", cliPushPath, ...args],
      { env: { ...process.env, HOME: home, PI_COST_URL: undefined, PI_COST_TOKEN: undefined, ...env } },
      (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
    );
  });

test("cli-push sends a directory of session files through the ingest endpoint", { timeout: 60000 }, async () => {
  const db = openDatabase(":memory:");
  migrateUp(db);
  const app = createApp(db, {
    // No sessions directory on this side, so the dashboard cannot be credited with the rows.
    sessionsDir: join(fakeHome, "no-sessions"),
    timeZone: "UTC",
    scanner: () => ({ enabled: false, reason: "sessions directory not found", fileCount: null }),
  });
  const server = await new Promise((boot) => {
    const listening = app.listen(0, "127.0.0.1", () => boot(listening));
  });

  try {
    const run = await runCliPush({
      args: [
        "--sessions-dir",
        fixturesDir,
        "--url",
        `http://127.0.0.1:${server.address().port}/api/ingest`,
        "--token",
        "",
      ],
    });

    assert.equal(run.code, 0, `the CLI exited non-zero: ${run.stdout}${run.stderr}`);

    const files = readdirSync(fixturesDir).filter((name) => name.endsWith(".jsonl"));
    assert.match(run.stdout, new RegExp(`sent\\s+${files.length} session\\(s\\)`), run.stdout);

    // Two of these fixtures are the same session id — a subagent and the fork made from it —
    // so five files are four sessions, and the dashboard keys rows on the id.
    const sessionIds = new Set(
      files.map((name) => JSON.parse(readFileSync(join(fixturesDir, name), "utf8").split("\n")[0]).id),
    );

    const rows = db.prepare("SELECT session_id, entry_count, last_source FROM sessions").all();
    assert.equal(rows.length, sessionIds.size, "every session in the directory landed in the dashboard's database");
    assert.ok(rows.every((row) => row.last_source === "push"), "and each is attributed to a push");

    const usageFacts = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
    assert.ok(usageFacts > 0, "the pushed sessions carry their usage facts, not just rollups");
  } finally {
    await new Promise((done) => server.close(done));
    db.close();
  }
});

// The order the CLI documents — flag, then saved settings, then environment — is easy to break
// with an object spread, and breaking it silently is the worst version: a settings file with no
// token key used to be read as "saved: no token", so every report went out unauthenticated, each
// 401 was counted as a refusal the server had answered, and the run still exited 0.
test("cli-push resolves its endpoint and token from flag, then settings, then environment", { timeout: 60000 }, async () => {
  const homeWithUrlOnly = mkdtempSync(join(tmpdir(), "pi-cost-cli-home-"));
  const homeWithNothing = mkdtempSync(join(tmpdir(), "pi-cost-cli-home-"));
  const extensionsDir = join(homeWithUrlOnly, ".pi", "agent", "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(
    join(extensionsDir, "pi-cost.json"),
    JSON.stringify({ url: "https://settings-file.invalid/api/ingest" }),
  );

  const urlOnlyFromSettings = ["--dry-run", "--sessions-dir", fixturesDir];
  const envWithToken = {
    PI_COST_URL: "http://127.0.0.1:9/api/ingest",
    PI_COST_TOKEN: "token-from-the-environment",
  };

  try {
    // One assertion proves both orders at once: the saved URL beats the environment's, and
    // the environment's token is still used because the settings file never mentions a token.
    const savedUrlEnvToken = await runCliPush({ args: urlOnlyFromSettings, home: homeWithUrlOnly, env: envWithToken });
    assert.match(
      savedUrlEnvToken.stdout,
      /endpoint\s+https:\/\/settings-file\.invalid\/api\/ingest \(with token\)/,
      `the saved endpoint wins and the environment token is still used: ${savedUrlEnvToken.stdout}`,
    );

    const clearWithFlag = await runCliPush({
      args: [...urlOnlyFromSettings, "--token", ""],
      home: homeWithUrlOnly,
      env: envWithToken,
    });
    assert.doesNotMatch(
      clearWithFlag.stdout,
      /\(with token\)/,
      '--token "" stays the deliberate "no token", overriding the environment',
    );

    const environmentOnly = await runCliPush({ args: urlOnlyFromSettings, home: homeWithNothing, env: envWithToken });
    assert.match(
      environmentOnly.stdout,
      /endpoint\s+http:\/\/127\.0\.0\.1:9\/api\/ingest \(with token\)/,
      `with no settings file the environment supplies both: ${environmentOnly.stdout}`,
    );

    const noTokenAnywhere = await runCliPush({
      args: [...urlOnlyFromSettings, "--url", "http://127.0.0.1:9/api/ingest"],
      home: homeWithNothing,
    });
    assert.doesNotMatch(noTokenAnywhere.stdout, /\(with token\)/, "no token anywhere means no token header");
  } finally {
    rmSync(homeWithUrlOnly, { recursive: true, force: true });
    rmSync(homeWithNothing, { recursive: true, force: true });
  }
});

// Every one of these would otherwise default to the most dangerous answer this command has:
// an unset limit means the whole directory, and a swallowed flag means an empty token.
test("cli-push refuses an argument it cannot read instead of guessing", { timeout: 60000 }, async () => {
  const readable = ["--dry-run", "--sessions-dir", fixturesDir, "--url", "http://127.0.0.1:9/api/ingest"];

  const limitWithoutValue = await runCliPush({ args: [...readable, "--limit"] });
  assert.equal(limitWithoutValue.code, 1, "a --limit with nothing after it must not mean 'no limit'");
  assert.match(limitWithoutValue.stderr, /--limit needs its value/);

  const flagEatingFlag = await runCliPush({ args: [...readable, "--token", "--dry-run"] });
  assert.equal(flagEatingFlag.code, 1, "--token must not swallow the next flag as its value");
  assert.match(flagEatingFlag.stderr, /--token needs its value/);

  const equalsForm = await runCliPush({ args: [...readable, "--limit=2"] });
  assert.equal(equalsForm.code, 1, "--limit=2 is not a spelling this command reads");
  assert.match(equalsForm.stderr, /I do not understand "--limit=2"/);
});
