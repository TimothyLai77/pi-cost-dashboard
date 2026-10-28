# Pi Cost Dashboard — Design

Tracks the dollar cost of every Pi coding-agent session and shows it on a web
dashboard as a time series.

Two parts:

| Folder | What it is |
|---|---|
| `pi-extension/` | A Pi extension. Adds `/pi-cost` and reports the live session to the server. |
| `dashboard/` | Express server + SQLite database + React app that stores and charts the cost. |

---

## 1. Goal and non-goals

**Goal**

- Total the cost of each Pi session, by day, by project, and by model.
- `/pi-cost` in a running Pi session reports that session to the server.
- A web dashboard charts daily spend over time with a project filter.
- Existing sessions are included. Backfill reads the 266 sessions already on disk.

**Non-goals**

- No prompt, transcript, tool-output, or file content ever leaves Pi. Numbers and IDs only.
- Not a billing system. It reports what Pi already computed from model catalog prices.
- Not multi-user. One machine, one person, served on localhost.
- No real-time guarantee. "Live" means within a few seconds of a run finishing.

---

## 2. Where the cost data comes from

Pi already writes cost into every session file. Sessions are JSONL at:

```
~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-uuid>.jsonl
```

`<encoded-cwd>` is the working directory with the leading separator removed and
`/`, `\`, `:` replaced by `-`. Example: `/home/user/git/media-serve` becomes
`--home-user-git-media-serve--`.

### The cost formula

Three kinds of entry carry usage, and all three count toward a session's cost.
This matches Pi's own implementation in
`dist/core/usage-totals.js` and `AgentSession.getSessionStats()`
(`dist/core/agent-session.js:3445`):

| Entry | Field read | Why it counts |
|---|---|---|
| `{type:"message", message.role:"assistant"}` | `message.usage` | The model response |
| `{type:"usage", kind:"..."}` | `usage` | Cache warming, tool-reported usage |
| `{type:"compaction"}` | `usage` | LLM call that generated the summary |
| `{type:"branch_summary"}` | `usage` | LLM call that summarized an abandoned branch |

```js
totalCost = Σ (usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite)
          = Σ usage.cost.total          // Pi precomputes this; use it
```

`usage` shape:

```json
{
  "input": 47, "output": 1461, "cacheRead": 16175, "cacheWrite": 0,
  "reasoning": 0, "totalTokens": 17683,
  "cost": { "input": 0.000002021, "output": 0.000631152, "cacheRead": 0, "cacheWrite": 0, "total": 0.000633173 }
}
```

### Two details that matter

**Scan all entries, not the current branch.** Pi's own stats use
`sessionManager.getEntries()` (every entry, including abandoned branches), not
`getBranch()`. Abandoned branches were paid for, so `getEntries()` is the
correct source for "money spent." The `custom-footer.ts` example uses
`getBranch()`, which under-reports on forked sessions. Do not copy that line
without changing it.

**Zero cost is real, not missing data.** Pi prices usage from the model
catalog (`cost.input` = USD per million tokens, `docs/models-configuration.md`).
A model with no price configured reports tokens at zero cost.

### Measured against this machine

Numbers below came from reading the live session directory, and they drive
several design decisions.

| Measurement | Value |
|---|---|
| Session files on disk | 266 |
| Session directory size | 117 MB |
| Full scan of everything | 433 ms |
| Largest single session | 18.6 MB, 4,682 entries |
| Cost summation, in memory, largest session | 0.27 ms |
| Total spend recorded to date | $60.97 |
| Distinct days with activity | 58 |
| Assistant messages | 13,898 |
| ...with cost above zero | 3,695 |
| ...reporting exactly zero | 10,203 |
| Sessions with any cost | 93 of 266 |

By provider: `llama.cpp` $55.20, `strata` $4.78, `llamacpp-secondary` $0.00.

So the fine-grained table below will hold roughly 14k rows today and about
85k rows a year at the current rate. That is small for SQLite, and it is what
makes accurate daily charting possible.

---

## 3. Architecture

```
┌───────────────────────── Pi process ─────────────────────────┐
│  pi-cost.ts                                                  │
│    /pi-cost          manual report (awaits, shows result)   │
│    agent_settled     fire-and-forget POST                   │
│    session_shutdown  awaited POST, 2s timeout               │
└───────────────┬──────────────────────────────────────────────┘
                │  POST /api/ingest   (numbers + IDs only)
                ▼
┌────────────────────────── dashboard/ ────────────────────────┐
│  Express                                                     │
│    /api/ingest    upsert a session snapshot                 │
│    /api/summary   today / 7d / 30d / all-time totals        │
│    /api/daily     time series, filtered by project/model    │
│    /api/sessions  paginated session table                   │
│    /api/models    per-model breakdown                       │
│    /api/rescan    force an incremental directory scan       │
│  Scanner  ── reads ~/.pi/agent/sessions/**/*.jsonl          │
│  SQLite   ── cost.db                                        │
└───────────────┬──────────────────────────────────────────────┘
                │  JSON  (vite dev proxy in dev, static files in prod)
                ▼
        React app + Recharts daily chart
```

Two independent paths reach the same tables:

- **Scanner** reads the session directory. It is the source of truth and the
  backfill for all pre-existing history.
- **Push** is Pi telling the server about the session it is running right now,
  which a directory scan cannot know about until the file is written.

Both write the same session row. The ingest guard in §7 makes that safe.

### Why SQLite

Cost arrives from two sources with no transaction between them, sessions get
resumed across process restarts and grow, and the chart needs a group-by over
fine-grained rows. That is a database, not a JSON snapshot. SQLite keeps it one
file with no daemon.

---

## 4. Data model

One aggregate table, one fine-grained fact table, one scan cache.

Design decision: **`usage_events` stores one row per usage-bearing entry**, not
one row per session. Reason: a session that runs across three days must
attribute its cost to those three days. A session-level rollup can only
attribute everything to the session start date, and the chart would show
incorrect spikes for long-running sessions. The fact table is the only place
the daily, per-project, and per-model breakdowns can be computed correctly.

### Money type

SQLite has no DECIMAL. Storing money as REAL violates "never FLOAT for money"
and makes sums drift. Use **integer micro-US dollars** (`cost_micros`, 1e-6 USD)
and format to dollars in the API layer.

Precision check against real data: the smallest per-request total measured here
is 0.000633173 USD → 633 micros. Worst-case rounding error is 0.5 micros per
event, so over 85,000 events in a year the bounded total error is under
$0.05, and errors are random-sign rather than cumulative. Adequate for a
spend dashboard, and sums stay exact.

`cost_micros` = `Math.round(usage.cost.total * 1e6)`. The float→int rounding
happens once, in the scanner, and never in a sum.

### DDL

`dashboard/server/migrations/001_init.sql`

```sql
CREATE TABLE sessions (
  session_id          TEXT    PRIMARY KEY,              -- Pi session UUID from header
  session_file        TEXT    NOT NULL UNIQUE,          -- absolute path
  parent_session_id   TEXT,                             -- set by /fork, /clone
  cwd                 TEXT    NOT NULL,                 -- header.cwd, the "project"
  name                TEXT,                             -- latest session_info name
  started_at          TEXT    NOT NULL,                 -- header.timestamp, ISO-8601 UTC
  last_activity_at    TEXT    NOT NULL,                 -- max entry timestamp
  entry_count         INTEGER NOT NULL,                 -- ingest monotonic guard
  cost_micros          INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  user_messages       INTEGER NOT NULL DEFAULT 0,
  assistant_messages  INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  tool_results        INTEGER NOT NULL DEFAULT 0,
  total_messages      INTEGER NOT NULL DEFAULT 0,
  last_source         TEXT    NOT NULL CHECK (last_source IN ('scan', 'push')),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE usage_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT    NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_id            TEXT    NOT NULL,                 -- session entry id
  kind                TEXT    NOT NULL CHECK (kind IN ('assistant','usage','compaction','branch_summary')),
  occurred_at         TEXT    NOT NULL,                 -- entry timestamp, ISO-8601 UTC
  provider            TEXT,                             -- assistant messages only
  model_id            TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_micros          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, entry_id)                        -- idempotent ingest
);

CREATE TABLE scan_state (
  session_file   TEXT    PRIMARY KEY,
  session_id     TEXT    NOT NULL,
  mtime_ms       INTEGER NOT NULL,                     -- unchanged ⇒ skip re-parse
  size_bytes     INTEGER NOT NULL,
  scanned_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### Indexes, matched to the queries that use them

```sql
-- Daily chart: range scan on date, then join for the project filter
CREATE INDEX idx_usage_events_occurred_at ON usage_events(occurred_at);

-- Rebuild/replace all events for one session during ingest
CREATE INDEX idx_usage_events_session_id  ON usage_events(session_id);

-- Per-model breakdown
CREATE INDEX idx_usage_events_model       ON usage_events(provider, model_id);

-- "Recent sessions" table, newest first
CREATE INDEX idx_sessions_last_activity   ON sessions(last_activity_at DESC);

-- Project filter drives the chart and session list
CREATE INDEX idx_sessions_cwd            ON sessions(cwd);
```

`idx_usage_events_session_id` is the foreign-key index, required for the
`ON DELETE CASCADE` to be cheap. `UNIQUE(session_id, entry_id)` is a usable
index for the ingest conflict target.

### Views for the rollups

Views, not tables: the fact table is small enough to group on every request,
and views cannot drift out of sync with it.

```sql
CREATE VIEW daily_cost AS
SELECT date(u.occurred_at)        AS day,
       s.cwd                      AS cwd,
       u.provider                 AS provider,
       u.model_id                 AS model_id,
       SUM(u.cost_micros)         AS cost_micros,
       SUM(u.total_tokens)        AS total_tokens,
       COUNT(DISTINCT u.session_id) AS sessions
FROM usage_events u
JOIN sessions s ON s.session_id = u.session_id
GROUP BY date(u.occurred_at), s.cwd, u.provider, u.model_id;

CREATE VIEW model_cost AS
SELECT provider,
       model_id,
       SUM(cost_micros)   AS cost_micros,
       SUM(total_tokens)  AS total_tokens,
       COUNT(*)           AS events
FROM usage_events
GROUP BY provider, model_id;
```

`date()` parses Pi's ISO-8601 timestamps including the trailing `Z`, so all
buckets are UTC days. `/api/daily` accepts a `tzOffset` query param and shifts
in SQL for a local-day chart; the default is UTC so stored data stays
unambiguous.

### Relationship summary

```
sessions 1 ────< usage_events        (CASCADE: deleting a session deletes its facts)
sessions 1 ────  1 sessions.parent_session_id   (nullable self-reference, no FK cascade)
scan_state 1 ─── 1 sessions (by session_file)
```

Self-reference on `parent_session_id` is deliberately not a foreign key with
cascade: deleting a child session must not delete its parent, and Pi deletes
session files on its own.

---

## 5. Ingest contract

`POST /api/ingest`, versioned so an older Pi extension cannot corrupt newer data.

```json
{
  "schemaVersion": 1,
  "sessionId": "01a18334-af65-7710-ad27-dc555fb245ce",
  "sessionFile": "/home/user/.pi/agent/sessions/--home-user--/2026-10-28T15-50-30-501Z_01a18334-....jsonl",
  "cwd": "/home/user",
  "name": "Refactor auth module",
  "startedAt": "2026-10-28T15:50:30.501Z",
  "lastActivityAt": "2026-10-28T16:41:02.117Z",
  "entryCount": 812,
  "totals": {
    "costMicros": 412330,
    "inputTokens": 90210,
    "outputTokens": 44120,
    "cacheReadTokens": 1240000,
    "cacheWriteTokens": 88000,
    "totalTokens": 1662330,
    "userMessages": 14,
    "assistantMessages": 61,
    "toolCalls": 128,
    "toolResults": 128,
    "totalMessages": 203
  },
  "events": [
    {
      "entryId": "b2c3d4e5",
      "kind": "assistant",
      "occurredAt": "2026-10-28T16:41:02.117Z",
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-5",
      "inputTokens": 47,
      "outputTokens": 1461,
      "cacheReadTokens": 16175,
      "cacheWriteTokens": 0,
      "totalTokens": 17683,
      "costMicros": 633
    }
  ],
  "reportedBy": "agent_settled",
  "reportedAt": "2026-10-28T16:41:04.000Z"
}
```

Notes:

- `events` is the complete set for the session, not a delta. Sending the
  complete set each time makes ingest a replace-inside-a-transaction, which is
  idempotent and needs no delta bookkeeping.
- `entryId` comes from the session entry. It is stable, so a re-send is a no-op.
- Payload for the worst session (4,682 entries) is about 700 KB. Acceptable on
  localhost. `/api/ingest` caps the request body at 5 MB and rejects larger,
  which also caps a malformed client.
- Nothing in the payload is conversation content. Enforced by validation:
  unknown keys are rejected, `name` is capped at 200 characters, and there is
  no prompt field to send.

### Validation on ingest

Server-side, in this order:

1. `schemaVersion === 1`, else `400` with `{ error: "unsupported_schema_version" }`.
2. `sessionId` matches `^[0-9a-f-]{36}$`.
3. Every `events[].entryId` non-empty, every `occurredAt` parses as ISO-8601.
4. Every numeric field is a finite non-negative number; `costMicros` integer.
5. Recompute: `totals` must be within 1% of the sum of `events`, else `422` with
   the mismatch. This catches a broken extension before it stores bad totals.
6. `entryCount >= sessions.entry_count` for an existing session (§7).

---

## 6. API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/ingest` | Upsert a session snapshot |
| `GET` | `/api/summary?days=7` | Totals for window: cost, tokens, sessions |
| `GET` | `/api/summary` | All-time totals plus today, 7d, 30d |
| `GET` | `/api/daily?from&to&cwd&provider&tzOffset` | Points for the chart |
| `GET` | `/api/sessions?limit&offset&cwd&sort` | Session table, newest first |
| `GET` | `/api/sessions/:id` | One session, full totals and events |
| `GET` | `/api/models` | Per-model spend, from `model_cost` |
| `POST` | `/api/rescan` | Run an incremental scan now, report what changed |
| `GET` | `/api/health` | DB path, session count, last scan time, schema version |

`/api/daily` response:

```json
{
  "range": { "from": "2026-10-01", "to": "2026-10-28", "tzOffsetMinutes": -420 },
  "totalCostUsd": 12.44,
  "points": [
    { "day": "2026-10-20", "costUsd": 2.11, "tokens": 402100, "sessions": 6 },
    { "day": "2026-10-21", "costUsd": 0.00, "tokens": 181000, "sessions": 4 }
  ]
}
```

`/api/health` is the operator's sanity check: if `sessionCount` stops tracking
the file count, the scanner is broken.

---

## 7. Reconciling scan and push

Both paths write the same session row, and a session grows over time as it is
resumed. Rules, in order of precedence:

1. **The file is the source of truth.** A scan of the current file always
   produces the correct numbers; a push is a snapshot of a moment.
2. **Monotonic guard.** A snapshot carries `entryCount`. An update for an
   existing session only applies when `incoming.entryCount >= stored.entryCount`.
   A stale push arriving after a fresher scan is discarded, so out-of-order
   arrival cannot lower a total.
3. **Scan wins on change.** `scan_state` stores `(mtime_ms, size_bytes)`. A
   session whose file has changed since last scan is re-parsed and its row
   rewritten from the file, ignoring any push for that session.
4. **Push is provisional.** `last_source = 'push'` marks rows that came from a
   running session. The next scan overwrites them with file-truth. The dashboard
   shows a `provisional` badge for these, so a live number is visibly not final.

Ingest upsert (the guard is the `WHERE` clause, which SQLite supports in
`ON CONFLICT DO UPDATE`):

```sql
INSERT INTO sessions (session_id, session_file, cwd, name, started_at, last_activity_at,
                      entry_count, cost_micros, /* ... */ last_source)
VALUES (:session_id, :session_file, :cwd, :name, :started_at, :last_activity_at,
        :entry_count, :cost_micros, /* ... */, 'push')
ON CONFLICT (session_id) DO UPDATE SET
  name = excluded.name,
  last_activity_at = excluded.last_activity_at,
  entry_count = excluded.entry_count,
  cost_micros = excluded.cost_micros,
  total_tokens = excluded.total_tokens,
  /* ... remaining rollups ... */
  last_source = 'push',
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE excluded.entry_count >= sessions.entry_count;
```

Then, in the same transaction, replace the facts for that session:

```sql
DELETE FROM usage_events WHERE session_id = :session_id;
INSERT INTO usage_events (session_id, entry_id, kind, occurred_at, provider, model_id,
                          input_tokens, output_tokens, cache_read_tokens,
                          cache_write_tokens, total_tokens, cost_micros)
VALUES ...;   -- one row per event, via a prepared multi-row insert
```

Replace-not-merge is chosen because the payload is the complete set. It is
correct under any arrival order and needs no per-entry conflict handling.

### Deleted and missing sessions

Pi deletes session files (`/resume` then Ctrl+D, using `trash` when available).
After a scan, any `sessions` row whose `session_file` no longer exists is
deleted, cascading to its `usage_events`. Documented as intentional: the
dashboard mirrors the files. `/api/rescan` returns `{ deleted: N }` so the
change is visible, not silent.

---

## 8. Scanner

`dashboard/server/scanner/aggregate.js` — pure function, no I/O beyond reading
one file:

```js
/**
 * Compute the cost rollup and per-entry usage facts for one Pi session file.
 * Mirrors Pi's AgentSession.getSessionStats(): all entries, all branches.
 *
 * @param {string} filePath  Absolute path to a session .jsonl file
 * @returns {{ session: SessionRecord, events: UsageEventRecord[] }}
 */
const aggregateSession = (filePath) => { ... };
```

`dashboard/server/scanner/scan.js`:

```js
/**
 * Incremental directory scan.
 * Walks the sessions directory, skips files whose (mtime, size) match
 * scan_state, aggregates the rest, and upserts.
 *
 * @param {string} sessionsDir  Absolute path to ~/.pi/agent/sessions
 * @param {Database} db
 * @returns {{ scanned: number, skipped: number, updated: number, deleted: number, ms: number }}
 */
const scanSessions = (sessionsDir, db) => { ... };
```

Behavior notes:

- Malformed lines are skipped, not fatal. Pi writes complete JSON per line, so
  a bad line means a truncated tail from a crash. Skip and count it, and expose
  it in `/api/health` as `skippedLines`.
- A file with no parseable header is skipped entirely.
- Sessions dir resolution, in order: `--sessions-dir` CLI arg →
  `PI_CODING_AGENT_SESSION_DIR` env → `sessionDir` in Pi's `settings.json` →
  `~/.pi/agent/sessions`. Relative paths in the setting resolve from cwd.
- Cold full scan: 433 ms measured. Warm scan touches `stat` only, so a periodic
  60-second rescan is effectively free.

Scan triggers: `POST /api/rescan`, a 60-second interval timer started at server
start (not at module load), and `npm run backfill` for the explicit first load.

---

## 9. Pi extension

`pi-extension/pi-cost.ts`, loaded by placing it in `~/.pi/agent/extensions/`
(symlink is fine; Pi uses jiti so TypeScript needs no build step).

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Nothing here touches the network. Pi loads extensions even when no session
  // starts, and the docs forbid starting sockets/timers in the factory.
  pi.registerCommand("pi-cost", { ... });
  pi.on("agent_settled", async (event, ctx) => { ... });
  pi.on("session_shutdown", async (event, ctx) => { ... });
}
```

### Command

`/pi-cost` with argument completions for `report`, `total`, `today`, `week`, `off`:

| Form | Behavior |
|---|---|
| `/pi-cost` | Compute this session's cost, `ctx.ui.notify` it, report to server, confirm |
| `/pi-cost report` | Same as above |
| `/pi-cost total` | Ask the server for all-time spend |
| `/pi-cost today` | Server totals for today |
| `/pi-cost week` | Server totals for last 7 days |
| `/pi-cost off` | Disable automatic reporting for this session |

`ctx.sessionManager` has **no** `getSessionStats()`, so the extension computes
the same formula from `getEntries()`. Measured cost: 0.27 ms on the largest
session in this machine's history.

```ts
/**
 * Sum session cost from entries, matching Pi's getSessionStats().
 * Uses getEntries(), not getBranch(): abandoned branches were billed too,
 * and compaction/branch-summary/usage entries carry usage outside messages.
 *
 * @param {ReadonlySessionManager} sm
 * @returns {{ costMicros: number, totalTokens: number, inputTokens: number, ... }}
 */
const computeSessionTotals = (sm) => { ... };
```

### Why `agent_settled` is the only safe automatic hook

Pi **awaits** `agent_settled` handlers. In `dist/core/agent-session.js:683`:

```js
async _emitAgentSettled() {
  this._isAgentRunActive = false;                       // idle: true before handlers
  this._isEmittingAgentSettled = true;
  try {
    await this._extensionRunner.emit({ type: "agent_settled", aborted });  // awaited
    this._emit({ type: "agent_settled", aborted });
```

and in `prompt()`, `dist/core/agent-session.js:1632`:

```js
async prompt(text, options) {
  if (this._isEmittingAgentSettled) {
    this._deferredSettledActions.push(async () => await this.prompt(text, options));
    return;
  }
```

So a prompt typed while the handler is running is **deferred until the handler
resolves**. A `fetch` to an unreachable server sitting on a TCP timeout would
stall the user's next prompt for its full timeout. That is the performance risk,
and it is the whole reason the report must not be awaited.

| Hook | Awaited by Pi | Blocks your next prompt | Verdict |
|---|---|---|---|
| `turn_end` | Yes, and it is an actionable boundary | Yes | No. Fires per model response, far too chatty |
| `agent_settled` | Yes | Yes, if you await | Yes, if you do not await |
| `session_shutdown` | Yes | No prompts remain | Use for the final report, safe to await |

### Automatic report: fire-and-forget

```ts
let inFlight: Promise<void> | null = null;
let lastReportMs = 0;

pi.on("agent_settled", async (event, ctx) => {
  if (!config.enabled || config.disabledForSession) return;
  if (config.skipAborted && event.aborted) return;
  if (Date.now() - lastReportMs < config.minIntervalMs) return;   // debounce
  if (inFlight) return;                                          // coalesce

  const payload = buildPayload(ctx, "agent_settled");            // 0.27 ms worst case
  if (payload.totals.costMicros === 0 && payload.totals.totalTokens === 0) return;

  lastReportMs = Date.now();
  // Not awaited on purpose. The handler resolves immediately, Pi is idle,
  // and the request lands in the background.
  inFlight = fetch(config.url, { method: "POST", body: JSON.stringify(payload),
                                signal: AbortSignal.timeout(config.timeoutMs) })
    .then(() => { inFlight = null; })
    .catch(() => { inFlight = null; });                          // never an unhandled rejection
});
```

The `.catch()` is mandatory: an unawaited rejected fetch is an unhandled
rejection, and Pi's process is not yours to crash.

`session_shutdown` is the opposite — it must be awaited, because process exit
kills in-flight requests:

```ts
pi.on("session_shutdown", async (event, ctx) => {
  if (!config.enabled) return;
  try {
    await fetch(config.url, { method: "POST", body: JSON.stringify(buildPayload(ctx, "shutdown")),
                              signal: AbortSignal.timeout(2000) });
  } catch {
    // Report failure only when there is UI, and never on the quit path where
    // a dialog would obstruct exit.
  }
});
```

Guards, all of them required:

- Never start a timer, socket, or watcher in the factory.
- `.catch()` on every unawaited fetch.
- In-flight coalescing: at most one request outstanding.
- Debounce via `minIntervalMs` (default 10000) so rapid settle/run cycles do not
  spam the server.
- `AbortSignal.timeout` (default 5000 for settled, 2000 for shutdown).
- Disabled when `PI_COST_URL` is unset. A Pi session with no dashboard
  configured performs no network work at all.

### Performance budget

| Work | Cost | Where |
|---|---|---|
| `computeSessionTotals` | 0.27 ms worst measured | in the handler, synchronous |
| `JSON.stringify` of payload | ~1–3 ms for the 700 KB worst case | in the handler |
| Handler overhead with fire-and-forget | ~0 (fetch not awaited) | — |
| Prompt stall | 0 ms by design | guarded by not awaiting |
| Shutdown report | up to 2000 ms, once | only at exit, nothing left to block |

If the stringify ever matters on a huge session, cap `events` in the payload to
the most recent 200 entries and let the scanner fill in the rest from the file.
The rollup totals stay exact either way. Listed as a known escape hatch, not
implemented by default.

### Failure modes

| Failure | Effect on Pi | Handling |
|---|---|---|
| Server down | None | `.catch()` swallows, report skipped, next scan recovers data |
| Server slow | None while fire-and-forget | in-flight coalescing blocks further pushes |
| Pi killed (`kill -9`) | — | No push. Scan recovers; the file has everything |
| Pi exits mid-request | — | Shutdown report is awaited with 2 s cap |
| Extension throws | Pi reports the handler error and continues | Wrap bodies in try/catch |
| Server rejects payload (422) | None | Log to `~/.pi/agent/extensions/pi-cost.log`, do not notify per attempt |

---

## 10. Dashboard

React + Vite + Recharts, served by Express.

Layout, top to bottom:

1. **Summary cards** — Today, Last 7 days, Last 30 days, All time. Each shows USD
   and token count. The all-time card is the headline number.
2. **Daily chart** — the main view. Recharts `LineChart` (or `ComposedChart` with
   bars) of cost per day. Controls: range (30 / 90 / 365 / all), project filter,
   provider filter, UTC vs local days toggle. A `ReferenceLine` at 0 makes the
   many zero-cost days legible.
3. **Model breakdown** — bar list of spend by provider/model, since the zero-cost
   finding makes this the most informative panel on this machine.
4. **Session table** — paginated, newest first: name, project, started, tokens,
   cost, `provisional` badge for push-only rows.

Zero-cost days are expected, not an anomaly (10,203 of 13,898 assistant messages
report zero). The chart must render $0.00 days as a flat line at zero, and the
summary cards must show tokens alongside cost, or a day that used 400k tokens for
free looks like an outage.

Dev: `vite` on 5173 proxies `/api` to the server on 4870.
Prod: `vite build` emits `web/dist`, Express serves it as static files, one
process, one port.

---

## 11. Repository layout

```
pi-cost-dashboard/
├── DESIGN.md
├── README.md
├── pi-extension/
│   ├── README.md
│   ├── pi-cost.ts              # the extension; symlink into ~/.pi/agent/extensions/
│   └── payload.schema.json     # ingest contract, versioned, also used by server validation
└── dashboard/
    ├── README.md
    ├── package.json
    ├── .env.example
    ├── server/
    │   ├── index.js            # express bootstrap + static serving
    │   ├── db.js               # better-sqlite3 handle, migration runner
    │   ├── migrations/
    │   │   └── 001_init.sql    # UP + DOWN, reversible
    │   ├── ingest.js           # POST /api/ingest: validate + guarded upsert
    │   ├── queries.js          # summary, daily, sessions, models
    │   └── scanner/
    │       ├── aggregate.js    # one file -> { session, events }  (pure)
    │       └── scan.js         # directory walk + scan_state cache
    └── web/
        ├── vite.config.js
        ├── index.html
        └── src/
            ├── main.jsx
            ├── App.jsx
            ├── api.js
            └── components/
                ├── SummaryCards.jsx
                ├── CostChart.jsx
                ├── ModelBreakdown.jsx
                └── SessionTable.jsx
```

`payload.schema.json` lives in `pi-extension/` because the extension defines the
contract, and `dashboard/server/ingest.js` validates incoming bodies against the
same file. One source of truth for both sides.

### Proposed dependencies — needs approval before install

Per `AGENTS.md`, nothing gets installed until approved.

| Package | Where | Why |
|---|---|---|
| `express` | server | HTTP, routing, static files |
| `better-sqlite3` | server | Synchronous SQLite, prepared statements; ships a native module, needs a compiler toolchain |
| `cors` | server | Only if vite dev server stays on a separate origin |
| `dotenv` | server | `.env` for port, sessions dir, token |
| `react`, `react-dom` | web | UI |
| `vite` | web | Bundler, dev proxy |
| `recharts` | web | Line and bar charts |
| `concurrently` | dev root | Run server and vite together |

Alternatives noted for later decisions: `node:http` in place of express, a CDN
Chart.js page in place of the React app, `sqlite3` (async) in place of
`better-sqlite3`. Not chosen: express and better-sqlite3 are the lower-friction
pair for a synchronous, single-file DB.

---

## 12. Configuration

| Setting | Env var | Default |
|---|---|---|
| Server URL the extension posts to | `PI_COST_URL` | unset ⇒ extension is inert |
| Disable automatic reporting | `PI_COST_AUTO=0` | auto enabled when URL is set |
| Request timeout, settled | `PI_COST_TIMEOUT_MS` | 5000 |
| Report debounce floor | `PI_COST_MIN_INTERVAL_MS` | 10000 |
| Shared secret header | `PI_COST_TOKEN` | unset (localhost only) |
| Server port | `PI_COST_PORT` | 4870 |
| Sessions directory | `PI_CODING_AGENT_SESSION_DIR` | `~/.pi/agent/sessions` |
| Database path | `PI_COST_DB` | `dashboard/data/cost.db` |

The extension reads `process.env` directly. A future config file
(`~/.pi/agent/extensions/pi-cost.json`) is listed as a follow-up so settings
survive without a shell profile; env vars first because they need no parser.

The server binds `127.0.0.1` by default and requires `x-pi-cost-token` when
`PI_COST_TOKEN` is set. It is not internet-facing; do not expose it.

## 13. Privacy

Payload contains: session UUID, file path, cwd, session display name, counts,
token counts, costs, timestamps, provider, model id. No prompt text, no
assistant text, no tool input or output, no file contents, no credentials.

Server rejects unknown keys in the payload (§5 step 1–5) so a future extension
version cannot quietly start shipping transcript data into the database.

## 14. Migrations and operations

- Migrations are numbered SQL files with `-- UP` and `-- DOWN` sections, applied
  by a small runner in `db.js` tracked in a `schema_meta` table.
- Reversible from the first migration, so `001_init.sql` includes the DOWN.
- `cost.db` is a single file, excluded from git, backed up by copying it.
- `npm run backfill` — full scan, prints a table, safe to re-run (idempotent by
  `scan_state`).
- `npm run verify` — compares `SELECT COUNT(*) FROM sessions` against a plain
  `find ... | wc -l` and prints the diff, plus a grand-total cost comparison
  against the independent scanner in the appendix. Catches scanner bugs early.
- If a session file is deleted after being ingested, the row is removed on the
  next scan (§7). Retention is therefore "as long as the files exist," which
  keeps the dashboard and Pi's own session list consistent.

## 15. Test plan

| Level | Checks |
|---|---|
| Unit: `aggregate.js` | Fixture JSONL with all four usage-bearing entry types; asserts cost equals the sum of all four, and that a `usage`-only session (cache warm) is counted |
| Unit: scanner | Cold scan, warm scan with unchanged files skips all, changed mtime re-parses one, missing file deletes the row |
| Unit: ingest guard | Stale `entryCount` rejected; equal accepted; out-of-order arrival never lowers `cost_micros` |
| Unit: validation | Bad `schemaVersion`, negative token, non-numeric cost, oversized body, unknown key |
| Integration | Backfill this machine's 266 sessions, assert total ≈ $60.97 and count = 266 |
| Integration | Chart query returns 58 day buckets with correct UTC grouping |
| Extension | Load with `pi --extension ./pi-cost.ts`; run `/pi-cost`; confirm totals match `/session` for the same session |
| Extension perf | Point `PI_COST_URL` at a sink that sleeps 5 s; confirm the next prompt is not delayed, proving the report is not awaited |
| Extension offline | Point at a dead port; confirm no notification, no error dialog, Pi unaffected |

---

## 16. Build order

Each phase leaves something runnable. Stop and report after each.

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 | `aggregate.js` + fixtures; cost of one file, printed by a CLI | §2 formula |
| 2 | SQLite schema + migration runner + `backfill` CLI | Phase 1 |
| 3 | Express: `/api/summary`, `/api/daily`, `/api/sessions`, `/api/health` | Phase 2 |
| 4 | React app: summary cards + daily chart | Phase 3 |
| 5 | `/api/ingest` + guard + validation | Phase 2 |
| 6 | Extension: `/pi-cost` command, manual report only | Phase 5 |
| 7 | Extension: `agent_settled` fire-and-forget + `session_shutdown` awaited | Phase 6 |
| 8 | Model breakdown panel, provisional badge, `/api/rescan` timer | Phases 3–5 |

Phase 4 already delivers a useful dashboard over historical data, which is why
the extension comes after it. Phase 7 is last because it is the only part that
touches Pi's hot path.

---

## 17. Open questions

1. **Chart library** — Recharts is assumed. No objection recorded yet, and it is
   the safe default for a line + bar dashboard.
2. **Server process management** — run it by hand, `pm2`, systemd unit, or a
   container alongside the existing `~/docker-compose.yml`? Affects only Phase 8.
3. **Session display name** — Pi stores it via `session_info` entries, but many
   sessions have none. Fall back to the first user message? That would put prompt
   text in the database, which §13 rules out. Current design: fall back to the
   session id short form.
4. **Long sessions across midnight** — the fact table attributes them correctly,
   so no action needed. Noted so nobody "fixes" the session rollup to match.
5. **Cost in a currency other than USD** — Pi's catalog prices are USD per million
   tokens. A display-currency option is a formatting concern only; store micros.
6. **Should `/pi-cost` work in `--mode json` / RPC?** The command is UI-optional
   (`ctx.hasUI`). Reporting still works with no UI, so the design supports
   headless Pi runs. Confirm that headless reporting is wanted before Phase 7.

---

## Appendix A — Independent scanner used for the measurements

The scanner used to produce every number in §2. No dependencies, Node 24. It is
kept here because it is the reference implementation for `aggregate.js` and the
independent check `npm run verify` compares against.

```js
// node scan-cost.js [sessionsDir]
const fs = require("fs");
const path = require("path");

const sessionsDir = process.argv[2] || path.join(process.env.HOME, ".pi/agent/sessions");
const files = [];

/** @param {string} dir Recursively collect *.jsonl under dir */
const collect = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(p);
    else if (p.endsWith(".jsonl")) files.push(p);
  }
};

/**
 * Aggregate one session file. Usage counts from assistant messages, usage
 * entries, compaction entries, and branch-summary entries.
 * @param {string} file
 * @returns {{sessionId: string, cwd: string, costMicros: number, totalTokens: number, events: number}}
 */
const aggregate = (file) => {
  let sessionId = "", cwd = "", costMicros = 0, totalTokens = 0, events = 0;
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session") { sessionId = entry.id; cwd = entry.cwd; continue; }
    const usage =
      entry.type === "usage" ? entry.usage
      : (entry.type === "compaction" || entry.type === "branch_summary") && entry.usage ? entry.usage
      : entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage
      : null;
    if (!usage) continue;
    events++;
    costMicros += Math.round((usage.cost?.total ?? 0) * 1e6);
    totalTokens += usage.totalTokens ?? 0;
  }
  return { sessionId, cwd, costMicros, totalTokens, events };
};

collect(sessionsDir);
const rows = files.map(aggregate);
const sumMicros = rows.reduce((a, r) => a + r.costMicros, 0);
console.log(`sessions: ${rows.length}  cost: $${(sumMicros / 1e6).toFixed(2)}  events: ${rows.reduce((a, r) => a + r.events, 0)}`);
const byProject = new Map();
for (const r of rows) byProject.set(r.cwd, (byProject.get(r.cwd) ?? 0) + r.costMicros);
[...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([cwd, micros]) => console.log(`  $${(micros / 1e6).toFixed(2).padStart(8)}  ${cwd}`));
```

## Appendix B — Pi internals this design depends on

| Fact | Source |
|---|---|
| Cost formula: assistant + usage + compaction + branch_summary | `dist/core/usage-totals.js`, `dist/core/agent-session.js:3445` |
| Pi's stats use all entries, not the current branch | `dist/core/agent-session.js:3452` (`getEntries()`) |
| `SessionStats` includes `cost` and token breakdown | `dist/core/agent-session.d.ts:200-218` |
| Extensions get `ReadonlySessionManager`, no `getSessionStats()` | `dist/core/extensions/types.d.ts:213`, `dist/core/session-manager.d.ts:178` |
| `getEntries()` is available to extensions | `dist/core/session-manager.d.ts:334` |
| `agent_settled` handlers are awaited | `dist/core/agent-session.js:689` |
| Prompts are deferred while `agent_settled` runs | `dist/core/agent-session.js:686, 1632` |
| `isIdle` is already true when `agent_settled` fires | `dist/core/agent-session.js:685, 1072` |
| Session entries are appended with `appendFileSync` as they occur, so the file is complete at shutdown | `dist/core/session-manager.js:812` |
| `session_shutdown` reasons: quit/reload/new/resume/fork | `dist/core/extensions/types.d.ts:637` |
| `registerCommand(name, { description, getArgumentCompletions, handler })` | `dist/core/extensions/types.d.ts:1231` |
| `get_session_stats` over RPC, for external callers | `docs/rpc-commands.md:528` |
| Model pricing is USD per million tokens, tiers supported | `docs/models-configuration.md:40-50` |
| Sessions dir: setting, `PI_CODING_AGENT_SESSION_DIR`, `--session-dir` | `docs/settings.md:66`, `docs/cli.md:96` |
| Reference extension that computes cost in a footer | `examples/extensions/custom-footer.ts` |
| Reference extension for shutdown-hook finalization | `examples/extensions/auto-commit-on-exit.ts` |
