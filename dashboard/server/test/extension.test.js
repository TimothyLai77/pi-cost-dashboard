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
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { aggregateSession } from "../scanner/aggregate.js";
import { validateIngestPayload } from "../ingest.js";
import { createApp } from "../index.js";
import { migrateUp, openDatabase } from "../db.js";

const extensionPath = join(import.meta.dirname, "..", "..", "..", "pi-extension", "pi-cost.ts");
const {
  buildPayload,
  buildSnapshot,
  clearSettings,
  effectiveConfig,
  maskSecret,
  postBackground,
  readSettings,
  requestForProtocol,
  resolveSettingsAction,
  runSettingsAction,
  validateEndpoint,
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
