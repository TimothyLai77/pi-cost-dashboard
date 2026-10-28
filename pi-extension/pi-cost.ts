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

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
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
}

/**
 * Read configuration from the environment.
 *
 * An unset PI_COST_URL disables the extension entirely, which is the default state: no
 * network calls, no file writes, nothing to notice.
 *
 * @returns {Config | null} null when reporting is not configured
 */
const readConfig = (): Config | null => {
  const url = process.env.PI_COST_URL;
  if (!url) return null;

  const number = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    url,
    autoEnabled: process.env.PI_COST_AUTO !== "0",
    timeoutMs: number("PI_COST_TIMEOUT_MS", 5000),
    minIntervalMs: number("PI_COST_MIN_INTERVAL_MS", 10000),
    shutdownTimeoutMs: number("PI_COST_SHUTDOWN_TIMEOUT_MS", 2000),
    token: process.env.PI_COST_TOKEN,
    logFile: join(homedir(), ".pi", "agent", "extensions", "pi-cost.log"),
  };
};

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

export default function (pi: ExtensionAPI) {
  const config = readConfig();

  // No server configured: register nothing, so an unconfigured Pi session does no work.
  if (!config) return;

  let disabledForSession = false;
  let lastReportMs = 0;
  let inFlight: Promise<void> | null = null;

  /**
   * Send a payload. Resolves with the parsed response, rejects on transport failure.
   * @param {object} payload
   * @param {number} timeoutMs
   */
  const post = async (payload: object, timeoutMs: number): Promise<Record<string, any>> => {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { "x-pi-cost-token": config.token } : {}),
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
          const summaryUrl = new URL("/api/summary", config.url).toString();
          const response = await fetch(`${summaryUrl}?days=${windowDays}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(config.timeoutMs),
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
        const body = await post(buildPayload(snapshot, "command"), config.timeoutMs);
        ctx.ui.notify(
          `Reported ${formatUsd(snapshot.costMicros)} over ${snapshot.totalTokens.toLocaleString("en-US")} tokens${
            body.applied === false ? " (server kept a newer snapshot)" : ""
          }`,
          "info",
        );
      } catch (error) {
        logLine(config, `command report failed: ${(error as Error).message}`);
        ctx.ui.notify(`Report failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.autoEnabled || disabledForSession) return;
    // Automatic reports run in interactive sessions only. A print-mode run has no prompts
    // to keep fast, and the scanner picks its file up seconds later.
    if (ctx.mode !== "tui") return;
    if (Date.now() - lastReportMs < config.minIntervalMs) return;
    if (inFlight) return; // coalesce: at most one request outstanding

    let payload: object;
    try {
      const snapshot = buildSnapshot(ctx.sessionManager);
      if (!snapshot) return;
      // A session with no usage has nothing to report; skip it silently.
      if (snapshot.costMicros === 0 && snapshot.totalTokens === 0) return;
      payload = buildPayload(snapshot, "agent_settled");
    } catch (error) {
      logLine(config, `snapshot failed: ${(error as Error).message}`);
      return;
    }

    lastReportMs = Date.now();

    // Deliberately not awaited. Pi awaits this handler and defers prompts while it runs,
    // so awaiting a network call here would stall your next prompt for its full timeout.
    // postBackground also unrefs its socket, so the request is not a reason for Pi to stay
    // alive, and it resolves rather than rejecting: an unawaited rejection would be an
    // unhandled rejection, and this process is Pi's, not ours.
    inFlight = postBackground(config, payload).then(() => {
      inFlight = null;
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!config.autoEnabled || disabledForSession) return;

    try {
      const snapshot = buildSnapshot(ctx.sessionManager);
      if (!snapshot) return;
      if (snapshot.costMicros === 0 && snapshot.totalTokens === 0) return;

      // Awaiting here is required: process exit kills in-flight requests. Nothing is
      // blocked, because there are no prompts left after shutdown. The timeout is short
      // so quitting Pi stays responsive when the server is down.
      await post(buildPayload(snapshot, "shutdown"), config.shutdownTimeoutMs);
    } catch (error) {
      logLine(config, `shutdown report failed: ${(error as Error).message}`);
    }
  });
}
