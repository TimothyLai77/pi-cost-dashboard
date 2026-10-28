/**
 * pi-cost: report Pi session cost to the pi-cost-dashboard server.
 *
 * Install: symlink this file into ~/.pi/agent/extensions/pi-cost.ts
 *   ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
 * Develop against a single session:
 *   pi --extension ./pi-cost.ts
 *
 * Inert when PI_COST_URL is unset: an unconfigured Pi session does no network work at all.
 *
 * ── Why reports are never awaited on agent_settled ────────────────────────────────
 *
 * Pi awaits `agent_settled` handlers (dist/core/agent-session.js:689) and defers prompts
 * while they run (dist/core/agent-session.js:1632):
 *
 *     async prompt(text, options) {
 *       if (this._isEmittingAgentSettled) {
 *         this._deferredSettledActions.push(async () => await this.prompt(text, options));
 *         return;
 *       }
 *
 * So a handler that awaits a fetch to an unreachable server stalls your next prompt for
 * the full timeout. That is the whole reason the automatic report is fire-and-forget:
 * the handler resolves immediately, Pi is idle, and the request lands in the background.
 *
 * `session_shutdown` is the opposite case. Process exit kills in-flight requests, so that
 * report must be awaited, and nothing is left to block because there are no prompts after it.
 *
 * ── Why automatic reports only run in interactive sessions ───────────────────────
 *
 * Measured against a sink that sleeps 5 seconds per request, `pi -p` took 6.0 s with
 * automatic reporting and 1.0 s without it. Not awaiting the fetch keeps your prompts
 * fast, but an outstanding request keeps Node's event loop alive, so a non-interactive
 * run cannot exit until it finishes. Unrefing the socket fixes that, and skipping the
 * automatic report outside interactive mode avoids the whole question: the scanner reads
 * the session file from disk a moment later anyway, so a print-mode run loses nothing.
 *
 * Nothing is started in the extension factory. Pi loads extensions even when no session
 * starts, and the docs forbid starting sockets, timers, or watchers there.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

/**
 * The session manager as extensions receive it.
 *
 * The package does not export `ReadonlySessionManager` by name, so the type is derived
 * from the context property extensions actually use.
 */
type SessionSource = ExtensionContext["sessionManager"];

/** Micro-dollars per US dollar. */
const MICRO_DOLLARS_PER_DOLLAR = 1e6;

/** Payload contract version, matching pi-extension/payload.schema.json. */
const SCHEMA_VERSION = 1;

/** Usage kinds, matching the server contract. */
type UsageKind = "assistant" | "tool_result" | "usage" | "compaction" | "branch_summary";

interface UsageFact {
  entryId: string;
  kind: UsageKind;
  occurredAt: string;
  provider: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costMicros: number;
}

interface SessionSnapshot {
  sessionId: string;
  sessionFile: string;
  parentSessionId: string | null;
  parentSessionFile: string | null;
  cwd: string;
  name: string | null;
  startedAt: string;
  lastActivityAt: string;
  entryCount: number;
  costMicros: number;
  totalTokens: number;
  facts: UsageFact[];
}

interface Config {
  url: string;
  autoEnabled: boolean;
  timeoutMs: number;
  minIntervalMs: number;
  shutdownTimeoutMs: number;
  token: string | undefined;
  logFile: string;
  /** Where the endpoint came from, so /pi-cost-settings can say which one is in force. */
  source: "file" | "env";
}

/**
 * What `/pi-cost-settings` saves. Every key is optional and an absent key falls through to
 * the environment. `token: ""` is a saved choice too: it means "no token", so turning one
 * off does not require deleting the file.
 */
export interface SavedSettings {
  url?: string;
  token?: string;
  auto?: boolean;
}

/** Default path for saved settings, next to the extension's log file. @type {string} */
export const SETTINGS_FILE = join(homedir(), ".pi", "agent", "extensions", "pi-cost.json");

/**
 * Read saved settings.
 *
 * A missing file is normal: the extension is unconfigured. A corrupt file is treated the
 * same way, because a bad manual edit is not a reason to crash a session.
 *
 * @param {string} [file]
 * @returns {SavedSettings | null}
 */
export const readSettings = (file: string = SETTINGS_FILE): SavedSettings | null => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

    const saved: SavedSettings = {};
    if (typeof raw.url === "string") saved.url = raw.url;
    if (typeof raw.token === "string") saved.token = raw.token;
    if (typeof raw.auto === "boolean") saved.auto = raw.auto;
    return saved;
  } catch {
    return null;
  }
};

/**
 * Merge a patch into saved settings and write the file at mode 0600.
 *
 * The mode matters because the file holds the report token. `writeFileSync` only applies a
 * mode when it creates a file, so `chmodSync` enforces it on rewrites, and the extensions
 * directory is created when Pi has not made it yet.
 *
 * @param {SavedSettings} patch Keys to change
 * @param {string} [file]
 * @returns {SavedSettings | null} the saved state, null when the write failed
 */
export const writeSettings = (
  patch: SavedSettings,
  file: string = SETTINGS_FILE,
): SavedSettings | null => {
  const merged = { ...(readSettings(file) ?? {}), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    chmodSync(file, 0o600);
    return merged;
  } catch {
    return null;
  }
};

/**
 * Delete saved settings. An absent file counts as success.
 * @param {string} [file]
 * @returns {boolean}
 */
export const clearSettings = (file: string = SETTINGS_FILE): boolean => {
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
};

/**
 * Decide the settings the extension will use.
 *
 * Saved settings win: what `/pi-cost-settings` stored is authoritative, and an environment
 * variable applies only to a key the file does not set. Tuning values (timeouts, debounce)
 * stay environment-only; they are not worth a menu entry.
 *
 * @param {SavedSettings | null} saved
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config | null} null when no endpoint is configured, which disables reporting
 */
export const effectiveConfig = (
  saved: SavedSettings | null,
  env: Record<string, string | undefined> = process.env,
): Config | null => {
  const url = saved?.url || env.PI_COST_URL;
  if (!url) return null;

  const number = (name: string, fallback: number): number => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  const token = saved && "token" in saved ? saved.token : env.PI_COST_TOKEN;
  const auto = saved && typeof saved.auto === "boolean" ? saved.auto : env.PI_COST_AUTO !== "0";

  return {
    url,
    autoEnabled: auto,
    timeoutMs: number("PI_COST_TIMEOUT_MS", 5000),
    minIntervalMs: number("PI_COST_MIN_INTERVAL_MS", 10000),
    shutdownTimeoutMs: number("PI_COST_SHUTDOWN_TIMEOUT_MS", 2000),
    token: token || undefined,
    logFile: join(homedir(), ".pi", "agent", "extensions", "pi-cost.log"),
    source: saved?.url ? "file" : "env",
  };
};

/**
 * Read configuration: saved settings first, environment as the fallback.
 *
 * With no endpoint from either source the extension does nothing at all: no network calls,
 * no file writes, nothing to notice.
 *
 * @returns {Config | null} null when reporting is not configured
 */
const readConfig = (): Config | null => effectiveConfig(readSettings());

/**
 * Append one line to the extension log.
 *
 * Automatic reports stay silent in the UI. Without a log, a dead server would mean
 * numbers quietly missing from the dashboard, so failures get written down.
 *
 * @param {Config} config
 * @param {string} message
 * @returns {void}
 */
const logLine = (config: Config, message: string): void => {
  try {
    appendFileSync(config.logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // A log failure is not worth interrupting a session over.
  }
};

/**
 * Convert a US dollar amount to integer micro-dollars, rounded once.
 * @param {number | undefined} dollars
 * @returns {number}
 */
const toMicroDollars = (dollars: number | undefined): number =>
  Number.isFinite(dollars) ? Math.round((dollars as number) * MICRO_DOLLARS_PER_DOLLAR) : 0;

/**
 * Format micro-dollars for display.
 * @param {number} costMicros
 * @returns {string}
 */
const formatUsd = (costMicros: number): string => {
  const dollars = costMicros / MICRO_DOLLARS_PER_DOLLAR;
  const digits = costMicros > 0 && costMicros < 10000 ? 4 : 2;
  return `$${dollars.toFixed(digits)}`;
};

/**
 * Pull the parent session UUID out of a `parentSession` file path.
 *
 * Pi records a forked session's parent as a file path named
 * `<timestamp>_<uuid>.jsonl`. The dashboard keys sessions by UUID, so the id is extracted.
 *
 * @param {string | undefined} parentSessionPath
 * @returns {string | null}
 */
const parentSessionIdFromPath = (parentSessionPath: string | undefined): string | null => {
  if (typeof parentSessionPath !== "string") return null;
  const match = parentSessionPath.match(/_([0-9a-fA-F-]{36})\.jsonl$/);
  return match ? match[1] : null;
};

/**
 * Read the usage block from an entry that carries one, mirroring Pi's own accounting.
 *
 * Five entry types contribute usage. Tool-result usage is the one easy to miss: tools that
 * make nested model calls report it, and Pi adds it to session totals.
 *
 * @param {any} entry
 * @returns {{ kind: UsageKind, usage: any } | null}
 */
const usageFromEntry = (entry: any): { kind: UsageKind; usage: any } | null => {
  if (entry.type === "usage") return { kind: "usage", usage: entry.usage };
  if (entry.type === "compaction") return { kind: "compaction", usage: entry.usage };
  if (entry.type === "branch_summary") return { kind: "branch_summary", usage: entry.usage };
  if (entry.type !== "message") return null;

  const message = entry.message ?? {};
  if (message.role === "assistant") return { kind: "assistant", usage: message.usage };
  if (message.role === "toolResult") return { kind: "tool_result", usage: message.usage };
  return null;
};

/**
 * Compute the current session's cost rollup and per-entry usage facts.
 *
 * Uses getEntries(), not getBranch(). Abandoned branches were billed too, and compaction,
 * branch-summary, and usage entries carry usage outside messages. This mirrors
 * AgentSession.getSessionStats(), which the extension context does not expose. Measured
 * cost: 0.27 ms on the largest session file on this machine (4,682 entries).
 *
 * Exported so its output can be checked against the server's ingest validator.
 *
 * @param {SessionSource} sessionManager
 * @returns {SessionSnapshot | null} null when the session has no id
 */
export const buildSnapshot = (sessionManager: SessionSource): SessionSnapshot | null => {
  const entries = sessionManager.getEntries() as any[];
  const header = entries.find((entry) => entry.type === "session") ?? (sessionManager.getHeader() as any);

  const sessionId = header?.id ?? sessionManager.getSessionId();
  if (!sessionId) return null;

  const activeModel = { provider: null as string | null, modelId: null as string | null };
  const facts: UsageFact[] = [];

  let costMicros = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalMessages = 0;
  let entryCount = 0;
  let name: string | null = null;
  let lastActivityAt: string | null = null;

  for (const entry of entries) {
    if (entry.type === "session") continue;
    entryCount += 1;

    // ISO-8601 with fixed-width milliseconds, so string comparison is chronological.
    if (typeof entry.timestamp === "string" && entry.timestamp > (lastActivityAt ?? "")) {
      lastActivityAt = entry.timestamp;
    }

    if (entry.type === "model_change") {
      activeModel.provider = entry.provider ?? activeModel.provider;
      activeModel.modelId = entry.modelId ?? activeModel.modelId;
    }

    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.length > 0) {
      name = entry.name;
    }

    if (entry.type === "message") {
      totalMessages += 1;
      const role = entry.message?.role;
      if (role === "user") userMessages += 1;
      if (role === "toolResult") {
        toolResults += 1;
      }
      if (role === "assistant") {
        assistantMessages += 1;
        activeModel.provider = entry.message?.provider ?? activeModel.provider;
        activeModel.modelId = entry.message?.model ?? activeModel.modelId;
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          toolCalls += content.filter((block: any) => block?.type === "toolCall").length;
        }
      }
    }

    const found = usageFromEntry(entry);
    if (!found || !found.usage) continue;

    const usage = found.usage;
    const costForEntry = toMicroDollars(usage.cost?.total);
    const tokensForEntry = usage.totalTokens ?? 0;

    facts.push({
      entryId: entry.id,
      kind: found.kind,
      occurredAt: entry.timestamp,
      provider: entry.message?.provider ?? entry.provider ?? activeModel.provider,
      modelId: entry.message?.model ?? entry.model ?? activeModel.modelId,
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      totalTokens: tokensForEntry,
      costMicros: costForEntry,
    });

    costMicros += costForEntry;
    inputTokens += usage.input ?? 0;
    outputTokens += usage.output ?? 0;
    cacheReadTokens += usage.cacheRead ?? 0;
    cacheWriteTokens += usage.cacheWrite ?? 0;
    totalTokens += tokensForEntry;
  }

  const headerInfo = header ?? {};

  return {
    sessionId,
    sessionFile: sessionManager.getSessionFile() ?? "",
    parentSessionId: parentSessionIdFromPath(headerInfo.parentSession),
    // Pi records the parent as a file path. The server keeps the path alongside the id
    // it reads out of the name, so it can show where the nested session came from.
    parentSessionFile: typeof headerInfo.parentSession === "string" ? headerInfo.parentSession : null,
    cwd: headerInfo.cwd ?? sessionManager.getCwd(),
    name,
    startedAt: headerInfo.timestamp ?? lastActivityAt ?? new Date().toISOString(),
    lastActivityAt: lastActivityAt ?? new Date().toISOString(),
    entryCount,
    costMicros,
    totalTokens,
    facts,
  };
};

/**
 * Build the ingest payload for a snapshot.
 *
 * Exported so a test can send its output through the server's validator.
 *
 * @param {SessionSnapshot} snapshot
 * @param {"command" | "agent_settled" | "shutdown"} reportedBy
 * @returns {object} Body matching payload.schema.json v1
 */
export const buildPayload = (snapshot: SessionSnapshot, reportedBy: "command" | "agent_settled" | "shutdown") => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: snapshot.sessionId,
  sessionFile: snapshot.sessionFile,
  cwd: snapshot.cwd,
  name: snapshot.name,
  parentSessionId: snapshot.parentSessionId,
  parentSessionFile: snapshot.parentSessionFile,
  startedAt: snapshot.startedAt,
  lastActivityAt: snapshot.lastActivityAt,
  entryCount: snapshot.entryCount,
  totals: {
    costMicros: snapshot.costMicros,
    inputTokens: snapshot.facts.reduce((sum, fact) => sum + fact.inputTokens, 0),
    outputTokens: snapshot.facts.reduce((sum, fact) => sum + fact.outputTokens, 0),
    cacheReadTokens: snapshot.facts.reduce((sum, fact) => sum + fact.cacheReadTokens, 0),
    cacheWriteTokens: snapshot.facts.reduce((sum, fact) => sum + fact.cacheWriteTokens, 0),
    totalTokens: snapshot.facts.reduce((sum, fact) => sum + fact.totalTokens, 0),
  },
  events: snapshot.facts,
  reportedBy,
  reportedAt: new Date().toISOString(),
});

/**
 * The request function that matches a URL's protocol.
 *
 * `node:http` cannot speak TLS, so pointing `PI_COST_URL` at an https server through it
 * would send plaintext to port 443 and fail. The https module handles the handshake and
 * exposes the same socket, so the unref that keeps Pi's exit fast works for both.
 *
 * @param {string} protocol "http:" or "https:"
 * @returns {typeof httpRequest}
 */
export const requestForProtocol = (protocol: string) =>
  protocol === "https:" ? httpsRequest : httpRequest;

/**
 * Send a snapshot without blocking and without keeping the process alive.
 *
 * Uses node:http / node:https rather than fetch because the socket can be unref'd. Without
 * that, an outstanding request holds the event loop open and a non-interactive Pi run
 * waits for the server's answer before it can exit.
 *
 * Exported so a test can drive it against a real local server, plain and TLS.
 *
 * @param {Config} config
 * @param {object} payload
 * @returns {Promise<void>} Resolves when the request finishes, never rejects
 */
export const postBackground = (config: Config, payload: object): Promise<void> =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(config.url);
    } catch {
      resolve();
      return;
    }

    const body = JSON.stringify(payload);
    const req = requestForProtocol(target.protocol)(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(config.token ? { "x-pi-cost-token": config.token } : {}),
        },
        timeout: config.timeoutMs,
      },
      (response) => {
        // Drain the response so the socket can close, and ignore the status: a failed
        // report is logged, not surfaced, because nobody asked for it.
        response.resume();
        response.on("end", () => resolve());
      },
    );

    // The line that keeps Pi's exit fast: this request is not a reason to stay alive.
    req.on("socket", (socket) => socket.unref());
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (error: Error) => {
      logLine(config, `settled report failed: ${error.message}`);
      resolve();
    });

    req.write(body);
    req.end();
  });

/**
 * The dialog methods the settings command needs, as Pi's UI context provides them.
 */
export type SettingsUi = Pick<ExtensionUIContext, "select" | "input" | "confirm" | "notify">;

/** Actions offered by `/pi-cost-settings`, in menu order. @type {{key:string,label:string}[]} */
export const SETTINGS_ACTIONS = [
  { key: "show", label: "Show current settings" },
  { key: "url", label: "Set endpoint URL" },
  { key: "token", label: "Set report token" },
  { key: "auto", label: "Toggle automatic reporting" },
  { key: "test", label: "Test connection" },
  { key: "clear", label: "Clear saved settings" },
];

/**
 * Map command arguments to an action, so `/pi-cost-settings url` skips the menu.
 * @param {string} args Everything typed after the command name
 * @returns {{ key: string, label: string } | null} null when a menu should open
 */
export const resolveSettingsAction = (args: string): { key: string; label: string } | null => {
  const word = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  if (!word) return null;
  return SETTINGS_ACTIONS.find((action) => action.key === word) ?? null;
};

/**
 * Show a secret without printing it. Settings output gets read over shoulders and pasted
 * into chats, so the ends are the most that is ever displayed.
 *
 * @param {string} [secret]
 * @returns {string}
 */
export const maskSecret = (secret?: string): string => {
  if (!secret) return "none";
  if (secret.length <= 8) return `•••• (${secret.length} chars)`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
};

/**
 * Check a typed endpoint before saving it.
 * @param {string} raw What the user typed
 * @returns {{ ok: boolean, url?: string, message?: string }}
 */
export const validateEndpoint = (raw: string): { ok: boolean; url?: string; message?: string } => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, message: "An endpoint URL is required." };

  let target: URL;
  try {
    target = new URL(trimmed);
  } catch {
    return { ok: false, message: `That is not a URL: ${trimmed}` };
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, message: `Use http:// or https:// (got ${target.protocol})` };
  }
  if (!target.hostname) return { ok: false, message: "The URL has no host name." };
  if (target.pathname === "/" || target.pathname === "") {
    return { ok: false, message: "Point at the ingest endpoint, for example https://host/api/ingest" };
  }
  if (target.pathname !== "/api/ingest") {
    return {
      ok: true,
      url: target.toString(),
      message: `Saved, though the path is ${target.pathname}, not /api/ingest.`,
    };
  }
  return { ok: true, url: target.toString() };
};

/**
 * Reach the server the way the reports do, without reporting anything.
 *
 * `GET /api/health` proves the host, port, TLS chain, and proxy. A `POST` of an empty body
 * to the ingest endpoint proves the token: 401 means the secret is wrong, 400 means the
 * request cleared the token check and the validator rejected the empty body. A test
 * therefore writes nothing to the database.
 *
 * @param {Config} config
 * @returns {Promise<{ ok: boolean, authOk: boolean, lines: string[] }>}
 */
export const probeConnection = async (
  config: Config,
): Promise<{ ok: boolean; authOk: boolean; lines: string[] }> => {
  const target = new URL(config.url);
  const origin = `${target.protocol}//${target.host}`;
  const lines: string[] = [];

  let reachable = false;
  try {
    const health = await fetch(new URL("/api/health", origin).toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const body = await health.json().catch(() => ({})) as Record<string, any>;
    if (health.ok) {
      reachable = true;
      lines.push(`Reachable · ${body.sessionCount ?? 0} sessions, ${body.costUsd ?? "$0.00"} recorded`);
    } else {
      lines.push(`Server answered HTTP ${health.status}`);
    }
  } catch (error) {
    return { ok: false, authOk: false, lines: [`Not reachable: ${(error as Error).message}`] };
  }

  let authOk = false;
  try {
    const probe = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { "x-pi-cost-token": config.token } : {}),
      },
      body: "{}",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (probe.status === 401) {
      lines.push(config.token ? "Token rejected (401)" : "Server requires a token and none is set");
    } else if (probe.status === 400) {
      // The empty body reached the validator, which is past the token check.
      authOk = true;
      lines.push(config.token ? "Token accepted" : "Writes open (no token needed)");
    } else {
      lines.push(`Unexpected answer: HTTP ${probe.status}`);
    }
  } catch (error) {
    lines.push(`Token check failed: ${(error as Error).message}`);
  }

  return { ok: reachable, authOk, lines };
};

/**
 * One action of the settings flow, driven through Pi's dialog UI.
 *
 * @param {string} key One of the SETTINGS_ACTIONS keys
 * @param {{ ui: SettingsUi, refresh: () => void, current: () => Config | null, settingsFile?: string }} deps
 * @returns {Promise<void>}
 */
export const runSettingsAction = async (
  key: string,
  deps: {
    ui: SettingsUi;
    refresh: () => void;
    current: () => Config | null;
    settingsFile?: string;
  },
): Promise<void> => {
  const { ui, refresh, current } = deps;
  const file = deps.settingsFile ?? SETTINGS_FILE;
  const config = current();

  if (key === "show") {
    if (!config) {
      ui.notify("Pi cost reporting is off: no endpoint saved. Set PI_COST_URL, or choose Set endpoint URL.", "info");
      return;
    }
    ui.notify(
      [
        `Endpoint: ${config.url}`,
        `Token: ${maskSecret(config.token)}`,
        `Automatic reporting: ${config.autoEnabled ? "on" : "off"} (settled reports run in interactive sessions only)`,
        `Source: ${config.source === "file" ? "saved settings" : "environment variables"}`,
        `File: ${file}`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (key === "url") {
    const typed = await ui.input("Pi cost endpoint", "https://host.example/api/ingest");
    if (typed === undefined) {
      ui.notify("Endpoint unchanged.", "info");
      return;
    }
    const checked = validateEndpoint(typed);
    if (!checked.ok || !checked.url) {
      ui.notify(checked.message ?? "Invalid endpoint.", "error");
      return;
    }
    const saved = writeSettings({ url: checked.url }, file);
    refresh();
    if (!saved) {
      ui.notify(`Could not write ${file}`, "error");
      return;
    }
    ui.notify(`${checked.message ? `${checked.message}\n` : ""}Endpoint saved: ${checked.url}`, "info");
    return;
  }

  if (key === "token") {
    const typed = await ui.input("Pi cost report token", "empty sends no token");
    if (typed === undefined) {
      ui.notify("Token unchanged.", "info");
      return;
    }
    const saved = writeSettings({ token: typed.trim() }, file);
    refresh();
    if (!saved) {
      ui.notify(`Could not write ${file}`, "error");
      return;
    }
    ui.notify(saved.token ? `Token saved: ${maskSecret(saved.token)}` : "Token cleared, reports send none.", "info");
    return;
  }

  if (key === "auto") {
    // Without an endpoint there is nothing to report automatically, and saving a toggle
    // would leave a setting behind that only changes behaviour once a server exists.
    if (!config) {
      ui.notify("No endpoint configured, so there is nothing to report automatically. Set one first.", "info");
      return;
    }
    const next = !config.autoEnabled;
    const saved = writeSettings({ auto: next }, file);
    refresh();
    if (!saved) {
      ui.notify(`Could not write ${file}`, "error");
      return;
    }
    ui.notify(
      next
        ? "Automatic reporting on: reports go out when the agent settles."
        : "Automatic reporting off. /pi-cost still reports when you ask.",
      "info",
    );
    return;
  }

  if (key === "test") {
    if (!config) {
      ui.notify("No endpoint configured, so there is nothing to test.", "info");
      return;
    }
    const result = await probeConnection(config);
    // Reachable with a bad secret is worth a distinct signal: the address is fine and the
    // token is the thing to fix.
    const level = result.ok ? (result.authOk ? "info" : "warning") : "error";
    ui.notify(result.lines.join("\n"), level);
    return;
  }

  if (key === "clear") {
    const sure = await ui.confirm(
      "Clear saved settings",
      "Deletes the saved endpoint, token, and auto setting. Reporting stops unless the environment sets them.",
    );
    if (!sure) {
      ui.notify("Nothing cleared.", "info");
      return;
    }
    const cleared = clearSettings(file);
    refresh();
    ui.notify(cleared ? "Saved settings deleted." : `Could not delete ${file}`, cleared ? "info" : "error");
    return;
  }

  ui.notify(`Unknown setting action: ${key}`, "error");
};

export default function (pi: ExtensionAPI) {
  // Settings can change while Pi runs. /pi-cost-settings writes the settings file and every
  // report reads the current value, so saving an endpoint in a session that started
  // unconfigured begins reporting immediately -- no Pi restart.
  let config: Config | null = readConfig();
  const refreshConfig = (): void => {
    config = readConfig();
  };

  // Registered unconditionally: this command is how the endpoint gets set in the first
  // place, so it has to exist in a session that starts with no configuration.
  pi.registerCommand("pi-cost-settings", {
    description: "Set the pi-cost endpoint, report token, and automatic reporting",
    getArgumentCompletions: (prefix: string) => {
      const keys = SETTINGS_ACTIONS.map((action) => action.key);
      const matches = keys.filter((key) => key.startsWith(prefix));
      return matches.length > 0 ? matches.map((key) => ({ value: key, label: key })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Dialogs need a UI. In print, JSON, and RPC-without-dialogs runs this does nothing,
      // and whatever is already saved keeps being used for reporting.
      if (!ctx.hasUI) return;

      const picked =
        resolveSettingsAction(args) ??
        (await ctx.ui.select(
          "Pi cost settings",
          SETTINGS_ACTIONS.map((action) => action.label),
        ));
      if (!picked) return;

      // A subcommand yields an action object; the menu returns the chosen label.
      const key =
        typeof picked === "string"
          ? (SETTINGS_ACTIONS.find((action) => action.label === picked)?.key ?? picked)
          : picked.key;
      await runSettingsAction(key, {
        ui: ctx.ui,
        refresh: refreshConfig,
        current: () => config,
        settingsFile: SETTINGS_FILE,
      });
    },
  });

  let disabledForSession = false;
  let lastReportMs = 0;
  let inFlight: Promise<void> | null = null;

  /**
   * Send a payload. Resolves with the parsed response, rejects on transport failure.
   * @param {Config} active Configuration to send under
   * @param {object} payload
   * @param {number} timeoutMs
   */
  const post = async (
    active: Config,
    payload: object,
    timeoutMs: number,
  ): Promise<Record<string, any>> => {
    const response = await fetch(active.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(active.token ? { "x-pi-cost-token": active.token } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      throw new Error(`${response.status}: ${body.detail ?? body.error ?? response.statusText}`);
    }
    return body;
  };

  pi.registerCommand("pi-cost", {
    description: "Report this session's cost, or ask the server for totals",
    getArgumentCompletions: (prefix: string) => {
      const names = ["report", "total", "today", "week", "off", "on"];
      const matches = names.filter((name) => name.startsWith(prefix));
      return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const active = config;
      if (!active) {
        ctx.ui.notify("No pi-cost endpoint configured. Run /pi-cost-settings to set one.", "info");
        return;
      }

      const subcommand = args.trim().split(/\s+/)[0] ?? "report";

      if (subcommand === "off") {
        disabledForSession = true;
        ctx.ui.notify("Automatic reporting off for this session. /pi-cost on to re-enable.", "info");
        return;
      }
      if (subcommand === "on") {
        disabledForSession = false;
        ctx.ui.notify("Automatic reporting on.", "info");
        return;
      }

      // Server-side totals: what the dashboard already knows.
      if (subcommand === "total" || subcommand === "today" || subcommand === "week") {
        const windowDays = subcommand === "today" ? 1 : subcommand === "week" ? 7 : 3650;
        try {
          const summaryUrl = new URL("/api/summary", active.url).toString();
          const response = await fetch(`${summaryUrl}?days=${windowDays}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(active.timeoutMs),
          });
          const body = await response.json() as Record<string, any>;
          if (!response.ok) throw new Error(`${response.status}: ${body.error ?? response.statusText}`);
          const window = body.window ?? body.allTime;
          const label = subcommand === "total" ? "all time" : subcommand === "today" ? "today" : "last 7 days";
          ctx.ui.notify(`Pi spend, ${label}: ${window.costUsd} over ${window.sessions} sessions`, "info");
        } catch (error) {
          ctx.ui.notify(`Could not reach the cost server: ${(error as Error).message}`, "error");
        }
        return;
      }

      // Manual report: awaited, because you asked for it and want the answer.
      const snapshot = buildSnapshot(ctx.sessionManager);
      if (!snapshot) {
        ctx.ui.notify("No session id available to report.", "error");
        return;
      }
      if (snapshot.costMicros === 0 && snapshot.totalTokens === 0) {
        ctx.ui.notify("Nothing to report yet: this session has used no tokens.", "info");
        return;
      }

      try {
        const body = await post(active, buildPayload(snapshot, "command"), active.timeoutMs);
        ctx.ui.notify(
          `Reported ${formatUsd(snapshot.costMicros)} over ${snapshot.totalTokens.toLocaleString("en-US")} tokens${
            body.applied === false ? " (server kept a newer snapshot)" : ""
          }`,
          "info",
        );
      } catch (error) {
        logLine(active, `command report failed: ${(error as Error).message}`);
        ctx.ui.notify(`Report failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const active = config;
    if (!active || !active.autoEnabled || disabledForSession) return;
    // Automatic reports run in interactive sessions only. A print-mode run has no prompts
    // to keep fast, and the scanner picks its file up seconds later.
    if (ctx.mode !== "tui") return;
    if (Date.now() - lastReportMs < active.minIntervalMs) return;
    if (inFlight) return; // coalesce: at most one request outstanding

    let payload: object;
    try {
      const snapshot = buildSnapshot(ctx.sessionManager);
      if (!snapshot) return;
      // A session with no usage has nothing to report; skip it silently.
      if (snapshot.costMicros === 0 && snapshot.totalTokens === 0) return;
      payload = buildPayload(snapshot, "agent_settled");
    } catch (error) {
      logLine(active, `snapshot failed: ${(error as Error).message}`);
      return;
    }

    lastReportMs = Date.now();

    // Deliberately not awaited. Pi awaits this handler and defers prompts while it runs,
    // so awaiting a network call here would stall your next prompt for its full timeout.
    // postBackground also unrefs its socket, so the request is not a reason for Pi to stay
    // alive, and it resolves rather than rejecting: an unawaited rejection would be an
    // unhandled rejection, and this process is Pi's, not ours.
    inFlight = postBackground(active, payload).then(() => {
      inFlight = null;
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const active = config;
    if (!active || !active.autoEnabled || disabledForSession) return;

    try {
      const snapshot = buildSnapshot(ctx.sessionManager);
      if (!snapshot) return;
      if (snapshot.costMicros === 0 && snapshot.totalTokens === 0) return;

      // Awaiting here is required: process exit kills in-flight requests. Nothing is
      // blocked, because there are no prompts left after shutdown. The timeout is short
      // so quitting Pi stays responsive when the server is down.
      await post(active, buildPayload(snapshot, "shutdown"), active.shutdownTimeoutMs);
    } catch (error) {
      logLine(active, `shutdown report failed: ${(error as Error).message}`);
    }
  });
}
