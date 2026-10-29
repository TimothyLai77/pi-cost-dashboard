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
| `{type:"message", message.role:"toolResult"}` | `message.usage` | Tools that make nested model calls report that usage here |
| `{type:"usage", kind:"..."}` | `usage` | Cache warming, extension-reported usage |
| `{type:"compaction"}` | `usage` | LLM call that generated the summary |
| `{type:"branch_summary"}` | `usage` | LLM call that summarized an abandoned branch |

Tool-result usage is easy to miss. `docs/extensions.md` states that the `usage` of
nested tool calls is folded into the calling tool's result, and Pi's stats loop adds
`message.usage` whenever a tool-result message carries it. A dashboard built only from
assistant messages silently drops that money. Most tool results carry no usage at all,
so the field is optional and absence is normal, not an error.

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

**Aborted and errored responses keep their usage.** Pi adds usage from every
assistant message regardless of `stopReason`, because the request was sent and
billed. Skipping aborted messages under-reports.

**A token total is throughput, not the size of a conversation.** Each assistant
message reports what *that call* used: new input, its output, and the cached
prefix the model re-read. With prompt caching, a late call in a long session
re-reads most of the context, so the session's token total grows with the number
of model calls. Measured on one long session on this machine:

| Measurement | Value |
|---|---|
| Assistant calls | 652 |
| Cache reads | 76,760,410 (99.2% of all tokens) |
| Input + output | 226,969 + 359,984 |
| Session total | 77,347,363 tokens, $10.13 |
| Median tokens per call | 110,996 |
| Largest single call | 245,790 (inside the 256k window) |
| Cache collapses (compaction, cache reset) | 5, each seen as a drop back to ~9k |

So a 77M session total is not a claim about a 77M-token context. The peak call is
245,790. The dashboard charts token volume for shape, and breaks it out by kind
(cache read, output, input, cache write) so the dominant term is visible.

**Nested subagent work is billed in two places.** Pi writes a subagent as its own
session file, and the parent records a `toolResult` usage entry summarising the
same nested calls. Both are real charges. Measured on this machine: 19 child
sessions (1,727,685 tokens, $0.0142) and 6 parent-side tool-result entries
(1,584,179 tokens, $0.0000, parent-side entries carry no price). So token totals
overlap by about 0.13% and dollar totals barely move, but the overlap is real.
Totals include both by default; `?subagents=0` on any aggregate query drops the
child sessions so you can read "what each session paid directly", and the session
list marks nested rows.

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
| Total spend recorded to date | $62.21 |
| Distinct days with activity | 58 |
| Assistant messages | 13,898 |
| ...with cost above zero | 3,695 |
| ...reporting exactly zero | 10,203 |
| Sessions with any cost | 93 of 266 |
| Usage-bearing entries (facts) | 13,973 |
| ...of which tool-result usage | 6 |

By provider: `llama.cpp` $55.20, `strata` $4.78, `llamacpp-secondary` $0.00.

The dollar total is a snapshot, not a constant: the session directory grows as Pi
is used, so the integration test in §15 compares on structure and formula, not on a
frozen dollar figure.

So the fine-grained table below will hold roughly 14k rows today and about
85k rows a year at the current rate. That is small for SQLite, and it is what
makes accurate daily charting possible.

### Cross-check

The aggregator was validated against an independently written scanner
(Appendix A) over all 266 real session files: both produced **$62.2134**, with
zero files where the new aggregator reported less than the reference, and 13,973
facts versus the reference's 13,967. The six-row gap is tool-result usage, which
the reference formula omits and Pi bills. See §5 for the ingest contract this
feeds.

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

### The bill in parts

`usage.cost` is not one number. Pi's pricing pass writes four — `input`, `output`,
`cacheRead`, `cacheWrite` — and the total, so the split of a call's cost is read off the
session file, not worked out from token counts and a price table. Migration
`003_cost_breakdown` keeps all four as `cost_input_micros`, `cost_output_micros`,
`cost_cache_read_micros`, `cost_cache_write_micros` on both `usage_events` and `sessions`.

Each part is rounded on its own, exactly like the total, so the four parts of an event can
land up to two micro-dollars away from its `cost_micros`, and a session's parts can drift
by that much per event. Measured on this machine's 15,069 events: worst single event 1
micro-dollar, worst session 7 micro-dollars ($0.000007). The parts are stored as Pi
reported them, and the ingest validator rejects a client whose parts are off by more than
that.

### DDL

`dashboard/server/migrations/001_init.sql`

```sql
CREATE TABLE sessions (
  session_id          TEXT    PRIMARY KEY,              -- Pi session UUID from header
  session_file        TEXT    NOT NULL UNIQUE,          -- absolute path
  parent_session_id   TEXT,                             -- set by /fork, /clone
  parent_session_file TEXT,                             -- the path Pi recorded there
  cwd                 TEXT    NOT NULL,                 -- header.cwd, the "project"
  name                TEXT,                             -- latest session_info name
  started_at          TEXT    NOT NULL,                 -- header.timestamp, ISO-8601 UTC
  last_activity_at    TEXT    NOT NULL,                 -- max entry timestamp
  entry_count         INTEGER NOT NULL,                 -- ingest monotonic guard
  cost_micros          INTEGER NOT NULL DEFAULT 0,
  cost_input_micros    INTEGER NOT NULL DEFAULT 0,     -- the same money, in the four parts
  cost_output_micros   INTEGER NOT NULL DEFAULT 0,     -- Pi's usage.cost reports them; they
  cost_cache_read_micros  INTEGER NOT NULL DEFAULT 0,  -- add up to cost_micros within a
  cost_cache_write_micros INTEGER NOT NULL DEFAULT 0,  -- rounding allowance
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
  kind                TEXT    NOT NULL CHECK (kind IN ('assistant','tool_result','usage','compaction','branch_summary')),
  occurred_at         TEXT    NOT NULL,                 -- entry timestamp, ISO-8601 UTC
  provider            TEXT,                             -- assistant messages only
  model_id            TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_micros          INTEGER NOT NULL DEFAULT 0,
  cost_input_micros    INTEGER NOT NULL DEFAULT 0,
  cost_output_micros   INTEGER NOT NULL DEFAULT 0,
  cost_cache_read_micros  INTEGER NOT NULL DEFAULT 0,
  cost_cache_write_micros INTEGER NOT NULL DEFAULT 0,
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
       SUM(u.cost_input_micros)   AS cost_input_micros,
       SUM(u.cost_output_micros)  AS cost_output_micros,
       SUM(u.cost_cache_read_micros)  AS cost_cache_read_micros,
       SUM(u.cost_cache_write_micros) AS cost_cache_write_micros,
       SUM(u.total_tokens)        AS total_tokens,
       COUNT(DISTINCT u.session_id) AS sessions
FROM usage_events u
JOIN sessions s ON s.session_id = u.session_id
GROUP BY date(u.occurred_at), s.cwd, u.provider, u.model_id;

CREATE VIEW model_cost AS
SELECT provider,
       model_id,
       SUM(cost_micros)   AS cost_micros,
       SUM(cost_input_micros)  AS cost_input_micros,
       SUM(cost_output_micros) AS cost_output_micros,
       SUM(cost_cache_read_micros)  AS cost_cache_read_micros,
       SUM(cost_cache_write_micros) AS cost_cache_write_micros,
       SUM(total_tokens)  AS total_tokens,
       COUNT(*)           AS events
FROM usage_events
GROUP BY provider, model_id;
```

`date()` parses Pi's ISO-8601 timestamps including the trailing `Z`, so all
buckets are UTC days. `/api/daily` accepts a `tzOffset` query param and shifts
in SQL for a local-day chart; the default is UTC so stored data stays
unambiguous.

### Timezone bucketing

Stored timestamps are UTC and stay UTC. Day and hour buckets are a display decision, made
in JavaScript through `Intl` (`server/timezone.js`) rather than in SQL: SQLite has no
timezone database, and the previous approach - a fixed `tzOffsetMinutes` applied to every
row in the range - is wrong on either side of a daylight-time transition. Measured: the
2026 US transitions are March 8 and November 1, and a fixed -420 offset applied for a whole
year would put Denver's summer days an hour late.

`PI_COST_TZ` sets the zone (an IANA name; `America/Denver`, `Europe/Berlin`, `Asia/Kolkata`,
`Australia/Eucla` all resolve, including half-hour and 45-minute offsets). Unset means UTC.
An unresolvable name falls back to UTC and prints a warning at startup rather than charting
in a zone the operator did not ask for. The zone drives:

- day buckets on the daily chart,
- the 24 hour labels in the drill-down,
- the Today / 7-day / 30-day summary windows, where "today" starts at local midnight,
- and the labels the page shows: the chart legends and the chart notes name
  the zone and its offset for the window in view (`UTC-6` for an October range in
  Denver, `UTC-7` for a January one).

There is deliberately no per-viewer control. The numbers on screen are computed server-side
in one zone, so the page reports which zone that is instead of letting each browser redraw
the same database differently.

### Model attribution

Assistant messages and `usage` entries name the model they were billed against.
Compaction, branch-summary, and tool-result usage name none. Rather than leaving that
spend in a null bucket, the aggregator tracks the model in effect while reading the
file: Pi writes a `model_change` entry on every switch, and each assistant message
names the model that answered. That pair is the fallback for entries that name no
model, which is the model that was configured when the cost was incurred.

On this machine's history that removes all unattributed spend (0 rows, 0 micro-dollars
in the by-model view). A per-model breakdown with a `null` bucket is not actionable,
so this is worth the extra state in the scanner.

### Relationship summary

```
sessions 1 ────< usage_events        (CASCADE: deleting a session deletes its facts)
sessions 1 ────  1 sessions.parent_session_id   (nullable self-reference, no FK cascade)
scan_state 1 ─── 1 sessions (by session_file)
```

Self-reference on `parent_session_id` is deliberately not a foreign key with
cascade: deleting a child session must not delete its parent, and Pi deletes
session files on its own.

Pi's header writes the parent as a **file path** (`<started>_<uuid>.jsonl`). The
scanner reads the 36-character UUID out of it into `parent_session_id` and keeps
the path in `parent_session_file`, so an id column only ever holds ids. Migration
`002_parent_link` repairs rows written before that, moving the stored path to the
file column and recovering the id from it. `parent_session_id IS NOT NULL` is what
marks a row as a nested subagent session.

---

## 5. Ingest contract

`POST /api/ingest`, versioned so an older Pi extension cannot corrupt newer data.

```json
{
  "schemaVersion": 2,
  "sessionId": "01a18334-af65-7710-ad27-dc555fb245ce",
  "sessionFile": "/home/user/.pi/agent/sessions/--home-user--/2026-10-28T15-50-30-501Z_01a18334-....jsonl",
  "cwd": "/home/user",
  "name": "Refactor auth module",
  "startedAt": "2026-10-28T15:50:30.501Z",
  "lastActivityAt": "2026-10-28T16:41:02.117Z",
  "entryCount": 812,
  "totals": {
    "costMicros": 412330,
    "costInputMicros": 88000,
    "costOutputMicros": 320330,
    "costCacheReadMicros": 4000,
    "costCacheWriteMicros": 0,
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
      "occurredAt": "2026-01-01T10:00:03.000Z",
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-5",
      "inputTokens": 47,
      "outputTokens": 1461,
      "cacheReadTokens": 16175,
      "cacheWriteTokens": 0,
      "totalTokens": 17683,
      "costMicros": 633,
      "costInputMicros": 141,
      "costOutputMicros": 489,
      "costCacheReadMicros": 3,
      "costCacheWriteMicros": 0
    },
    {
      "entryId": "c3d4e5f6",
      "kind": "tool_result",
      "occurredAt": "2026-01-01T10:00:04.000Z",
      "provider": "anthropic",
      "modelId": "claude-sonnet-4-5",
      "inputTokens": 10,
      "outputTokens": 20,
      "cacheReadTokens": 30,
      "cacheWriteTokens": 0,
      "totalTokens": 60,
      "costMicros": 500,
      "costInputMicros": 30,
      "costOutputMicros": 470,
      "costCacheReadMicros": 0,
      "costCacheWriteMicros": 0
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
- Version 2 added the four cost components, per event and in `totals`. They are required,
  so every stored row has a split, and they must add up to the `costMicros` next to them.
  Version 1 is rejected outright: the server accepts 2 only, which means the extension and
  the server deploy together, and a Pi still on the older extension stops reporting until it
  is updated (file scanning is unaffected).

### Validation on ingest

Server-side, in this order:

1. `schemaVersion === 2`, else `400` with `{ error: "unsupported_schema_version" }`.
2. `sessionId` matches `^[0-9a-f-]{36}$`.
3. Every `events[].entryId` non-empty, every `occurredAt` parses as ISO-8601.
4. Every numeric field is a finite non-negative number; `costMicros` integer.
5. Recompute: `totals` must be within 1% of the sum of `events`, else `422` with
   the mismatch. This catches a broken extension before it stores bad totals.
6. Recompute: the four cost components must add up to the `costMicros` they are reported
   next to — per event within 4 micro-dollars, per session within 2 micro-dollars per
   event. Each part is rounded on its own, so a couple of micro-dollars is arithmetic, and
   a cent is a broken client (§4).
7. `entryCount >= sessions.entry_count` for an existing session (§7).

---

## 6. API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/ingest` | Upsert a session snapshot |
| `GET` | `/api/summary?days=7` | Totals for window: cost, cost parts, tokens, sessions |
| `GET` | `/api/summary` | All-time totals plus today, 7d, 30d |
| `GET` | `/api/daily?from&to&cwd&provider` | Points for the chart, in `PI_COST_TZ` |
| `GET` | `/api/hourly?day&cwd&provider` | One day's 24 hours, zero-filled, in `PI_COST_TZ` |
| `GET` | `/api/config` | Zone the server buckets in, its offset label, and where the setting came from |
| `GET` | `/api/sessions?limit&offset&cwd&sort` | Session table, newest first |
| `GET` | `/api/sessions/:id` | One session, full totals and events |
| `GET` | `/api/models` | Per-model spend, from `model_cost` |
| `GET` | `/api/flows?metric&limit&from&to&cwd&provider&subagents` | Model→project graph: nodes, links, roll-up and drop counts |
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

Money leaves the API in the four parts Pi bills it in (§4). `/api/summary`, `/api/daily`
and `/api/hourly` carry a `costBreakdown` next to every cost figure:

```json
{
  "day": "2026-10-20",
  "costMicros": 2110000,
  "costUsd": "$2.11",
  "costBreakdown": {
    "input":     { "costMicros": 340000, "costUsd": "$0.34" },
    "output":    { "costMicros": 1760000, "costUsd": "$1.76" },
    "cacheRead": { "costMicros": 10000, "costUsd": "$0.01" },
    "cacheWrite": { "costMicros": 0, "costUsd": "$0.00" }
  }
}
```

Every part is a `{ costMicros, costUsd }` pair like the totals are, so a chart can split a
bar and a summary cell can name where the money went without summing floats. A bucket with
no spend has four zero parts, not a missing `costBreakdown`. The session list, session
detail and model ledger do not carry it: the page shows the split in the summary strip and
in the charts, and nothing in the page reads it from those three endpoints.

Every aggregate accepts `subagents=1` (default, count nested subagent sessions)
or `subagents=0` (count only what each session paid directly). Any other value is
a 400 naming the parameter.

`/api/health` is the operator's sanity check: if `sessionCount` stops tracking
the file count, the scanner is broken.

`/api/hourly` answers the drill-down question: which hours of a day actually cost
money. It takes one `day` in the same frame the daily chart labelled it, applies the
same project and provider filters, and returns all 24 hours including the empty ones,
so an idle hour is a visible zero rather than a missing bar. Cost lands in the hour the
usage happened, which is the same basis as the daily chart: a session that starts at
23:00 and runs past midnight bills its usage to both hours.

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

Provider and model come from the entry: assistant and tool-result messages name the
model that answered, and `usage` entries name the model they are attributed to.
Tool-result usage is billed against the model the nested call used.

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

- **Non-session JSONL exists in the sessions tree.** Pi writes subagent transcripts into
  a `subagent-artifacts` folder inside a project's session directory. The walk skips
  directories in `NON_SESSION_DIRECTORIES`, and the aggregator's header check is the
  second gate: a file whose first entry is not `type: "session"` is rejected and counted,
  never stored. On this machine that is 1 file out of 266.
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

### Automatic report: fire-and-forget, unref'd, interactive-only

Two separate problems had to be solved, and the second one was not visible in the code
reading:

1. **Pi awaits `agent_settled`.** Awaiting a fetch in the handler delays the next prompt.
   Solved by not awaiting.
2. **An outstanding request keeps Node's event loop alive.** Not awaiting is not enough:
   a print-mode run cannot exit while the request is open. Measured against a sink that
   sleeps 5 seconds per request, `pi -p` took 6.0 s with automatic reporting against 1.0 s
   with none — the 2 s cap did not save it, because the cap applies to the request that
   is awaited, and the unfinished background request is what kept the process alive.

Both are handled: the background request is built with `node:http` (or `node:https` for an
`https:` URL) so its socket can be `unref()`'d, which is not available through `fetch`; and
automatic reports run only when `ctx.mode === "tui"`. A print-mode run has no prompts to
protect, and in a deployment that scans session files the scanner reads its file seconds
later, so skipping the report loses nothing.

The protocol split is not cosmetic. The first version built every background request with
`node:http`, which cannot speak TLS: pointing `PI_COST_URL` at an https server sent
plaintext to port 443 and the report failed quietly, visible only in the extension log.
Since the awaited shutdown report uses `fetch` and does support TLS, that failure looks
like "some reports arrive". `requestForProtocol()` selects the module from the URL, and
`extension.test.js` drives `postBackground` against a real TLS server using a throwaway
self-signed localhost certificate, so the handshake is exercised rather than assumed.

```ts
pi.on("agent_settled", async (_event, ctx) => {
  if (!config.autoEnabled || disabledForSession) return;
  if (ctx.mode !== "tui") return;                    // print/RPC runs: the scanner covers them
  if (Date.now() - lastReportMs < config.minIntervalMs) return;
  if (inFlight) return;                              // coalesce: one request outstanding

  const snapshot = buildSnapshot(ctx.sessionManager);
  if (!snapshot) return;
  if (snapshot.costMicros === 0 && snapshot.totalTokens === 0) return;

  lastReportMs = Date.now();
  // Not awaited. postBackground also unrefs the socket and resolves rather than
  // rejecting, so this can neither stall the prompt nor keep the process alive.
  inFlight = postBackground(config, buildPayload(snapshot, "agent_settled"))
    .then(() => { inFlight = null; });
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

### Performance budget (measured)

Print-mode `pi -p` runs, same prompt and model, 5 samples per row:

| Configuration | Elapsed |
|---|---|
| Extension absent | 986–1442 ms |
| Extension reporting to a healthy server | 987–1825 ms |
| Extension + sink that sleeps 5 s per request, before the fix | 5985–6078 ms |
| Extension + the same 5 s sink, after the fix | 3174–3502 ms |

The last row is the baseline plus the awaited 2 s shutdown cap: a dead server costs 2
seconds at exit, once, and never costs a prompt anything. Reporting to a healthy server is
indistinguishable from not reporting.

| Work | Cost | Where |
|---|---|---|
| `buildSnapshot` | 0.27 ms worst measured (4,682 entries) | in the handler, synchronous |
| Handler overhead | ~0 ms (not awaited, socket unref'd) | — |
| Prompt stall | 0 ms by design | guarded by not awaiting |
| Print-mode overhead | 0 ms | auto reports skip non-TUI modes |
| Shutdown report | up to 2000 ms, once | only at exit, nothing left to block |

If the payload stringify ever matters on a huge session, cap `events` in the payload to
the most recent 200 entries and let the scanner fill in the rest from the file. The
rollup totals stay exact either way. Listed as a known escape hatch, not implemented.

### Failure modes

| Failure | Effect on Pi | Handling |
|---|---|---|
| Server down | None | request fails, is logged, report skipped; the scan recovers the data |
| Server slow | None for prompts | in-flight coalescing blocks further pushes |
| Slow server at exit (print mode) | up to 2 s once | awaited shutdown report with a 2 s cap |
| Slow server at exit (interactive) | None | socket is unref'd, exit does not wait |
| Pi killed (`kill -9`) | — | No push. Scan recovers; the file has everything |
| Extension throws | Pi reports the handler error and continues | Handler bodies are wrapped |
| Server rejects payload (4xx) | None | Logged to `~/.pi/agent/extensions/pi-cost.log` |
| Stale snapshot accepted nowhere | — | Server answers 200 with `applied: false`, so the client does not retry |

---

## 10. Dashboard

React + Vite + Recharts, served by Express.

Layout, top to bottom:

1. **Summary cards** — Today, Last 7 days, Last 30 days, All time. Each shows USD
   and token count. The all-time card is the headline number. Under the money figure sits
   a 100% stacked strip of the bill in the four parts the provider charged, and under that the
   same four in dollars — `out · in · cache read · cache write` —
   always all four, zeros included: most usage on this machine is priced at zero, and four
   `$0.00`s is the honest label for a window that did real work for free. Hovering names the
   exact micro-dollar figures, since each part is rounded for display and the four can add up
   to a cent away from the window's total. A server older than payload version 2 reports no
   split, and the line is absent rather than claiming four zeros under a non-zero total.
2. **Daily chart** — the main view. Recharts `LineChart` (or `ComposedChart` with
   bars) of cost per day. Controls: range (30 / 90 / 365 / all), project filter,
   provider filter, UTC vs local days toggle. A `ReferenceLine` at 0 makes the
   many zero-cost days legible. Each bar is stacked in the four parts the provider billed —
   completion tokens, prompt tokens, cache reads, cache writes — one hue each: burnt orange
   for completion, mustard for prompt, blue for cache reads, teal for cache writes. Warm is
   money paid per token of text, cool is the machine's own context traffic, which is the
   page's existing color language; inside each pair the parts are separated by hue rather than
   lightness, because lightness steps are hard to tell apart in a four-wide stack. Segments
   are separated by a hairline in the panel's own color, so the stack reads as ledger bands.
   The hourly drill-down stacks the same four, in the same colors, and the summary strip uses
   the same hues for the same parts.
3. **Money from model to project** — a flow diagram (Recharts `Sankey`): model nodes left,
   project nodes right, one band per pair, width = the metric. Money by default, tokens on a
   toggle, because on this machine the busiest model by tokens billed $0.00 and so has no
   width in the money view at all. Bands wear a dedicated seven-hue ramp (`--flow-1` …
   `--flow-7`) rather than the four cost hues: in the charts a hue means "which part of the
   bill", here it means "which model", and one color must not carry both meanings. Project
   nodes are neutral. Only the top `limit` nodes per side are drawn and the tail rolls into
   an `all other` node carrying its own full totals; pairs with none of the chosen metric are
   not drawn and are counted in the payload, and a node's label is one line — name plus its
   own dollars — because two lines of label need more vertical room than seven nodes per side
   afford.
4. **Model breakdown** — bar list of spend by provider/model, since the zero-cost
   finding makes this the most informative panel on this machine.
5. **Session table** — paginated, newest first: name, project, started, tokens,
   cost, `provisional` badge for push-only rows.

Zero-cost days are expected, not an anomaly (10,203 of 13,898 assistant messages
report zero). The chart must render $0.00 days as a flat line at zero, and the
summary cards must show tokens alongside cost, or a day that used 400k tokens for
free looks like an outage.

Dev: `vite` on 5173 proxies `/api` to the server on 4870.
Prod: `vite build` emits `web/dist`, Express serves it as static files, one
process, one port.

### Theme: ledger paper and ledger slate

Two palettes on one token set, switched by `<html data-theme>`. Light is the original
ink-on-cool-paper ledger. Dark is "Ledger slate": same temperature, inverted surface
(`#14171a` page, `#1b1f23` panels), with the money accent lifted from `#a6541f` to
`#e0873d` so cost figures stay the loudest numbers on the page. Chosen by contrast math,
not by eye: every text pair clears WCAG AA in both palettes (light 16.1 / 7.0 / 4.60:1 for
body, secondary, eyebrow; dark 14.8 / 9.4 / 5.42:1) and chart fills clear 3:1 against the
page. Auditing the dark set is what found a pre-existing light-mode miss: `--ink-faint`,
used for 11px uppercase eyebrows, measured 3.42:1 and is now `#67707a` at 4.60:1.

Two deliberate differences, not just an inversion:

- **Live is lilac in dark, cyan in light.** Cyan on a dark slate reads as a hyperlink, and
  lilac carries "this session is running now" without competing with the amber that means
  money.
- **The masthead rule has its own token.** `--rule-accent` is ink in light; ink on dark
  slate is 14.8:1, which reads as a lit line, so dark sets it to silver at 9.4:1. The
  ledger's rule should be the strongest line on the page, not the brightest.

The setting has three states. Auto follows the operating system and keeps following it
(the `matchMedia` list is live); Light and Dark pin it. The choice is stored in
localStorage; blocked storage falls back to Auto for the page load instead of breaking it.
An inline script in `index.html` applies the stored choice before the first paint, so a
reload in dark mode never flashes light first — the reason the logic exists in two places
and why `web/test/theme.test.js` pins `resolveMode` and the storage fallbacks.

Every color in the app already came from tokens, including the chart's strokes and fills,
so the dark palette is additive: one block of variable overrides, nothing component-level.

### The day drill-down: cross-fade, not swap

Clicking a day bar shows that day's 24 hours. The first version unmounted the daily chart,
put a one-line "Loading hours…" block in its place, and mounted the hourly chart when the
response landed: the panel went 300 px → 40 px → 290 px in three frames, which reads as a
flash and shoves every panel below it up and back down.

The frame is now a CSS grid with one cell (`grid-area: 1 / 1`), and both charts are layers in
it. A layer that is not on top is `opacity: 0` with `pointer-events: none` and `aria-hidden`,
so it keeps its measured size, takes no clicks, and is skipped by screen readers; the frame is
as tall as the taller chart at all times. The outgoing layer fades out on a transition; the
incoming one fades in on a mount animation, because a transition cannot animate an element's
first paint. Bars animate (350 ms) only when a series is new to the panel — keyed on range plus
filters for the daily chart and on the drilled day for the hourly one — so the 30 s refresh
updates numbers without re-running any animation.

While a day's data is on its way, the chart already on screen stays at full opacity with a
small "hours…" pill over it. The pill replaces nothing, so nothing moves.

`web/src/hourly.js` holds a keyed promise cache for the drill data: hover prefetches the
hovered bar's day, the five most recent days in the range are prefetched when the daily series
arrives, and a click on a cached day swaps with no request at all. The key includes the day and
every filter plus the refresh tick, so a cached day can never be served under a different
project, provider, subagent setting, or refresh. Entries are capped at 64 with
least-recently-used eviction, a failed entry is dropped so the next attempt asks again, and a
click on a day whose prefetch is in flight reuses that request instead of adding a second one.

Measured on the built app with recorded API payloads: panel 444 px, chart frame 350 px, page
1950 px across every frame of a click, from the click through the fade, with a cold day served
in ~6.2 s (daily chart visible with the pill the whole time, then the fade) and a cached day
fading over ~250 ms with no request at all.

---

## 11. Repository layout

```
pi-cost-dashboard/
├── DESIGN.md
├── README.md
├── pi-extension/
│   ├── README.md
│   ├── pi-cost.ts              # the extension; symlink into ~/.pi/agent/extensions/
│   ├── tsconfig.json           # type-check against Pi's declarations
│   └── payload.schema.json     # ingest contract, versioned, also used by server validation
└── dashboard/
    ├── README.md
    ├── package.json
    ├── .env.example
    ├── Dockerfile              # build stage compiles the app, runtime runs the server
    ├── compose.yml             # LAN deployment: bind, token, volume, healthcheck
    ├── .dockerignore
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
| `react`, `react-dom` | web | UI |
| `vite` | web | Bundler, dev proxy |
| `recharts` | web | Line and bar charts |
| `concurrently` | dev root | Run server and vite together |

`dotenv` was installed early and removed again: the server module now reads only
`process.env`, and env files are loaded by Node's own `--env-file-if-exists` flag in the
npm scripts (§12). Keeping the file read out of the module is what lets the test suite run
without inheriting a developer's local config.

Alternatives noted for later decisions: `node:http` in place of express, a CDN
Chart.js page in place of the React app, `sqlite3` (async) in place of
`better-sqlite3`. Not chosen: express and better-sqlite3 are the lower-friction
pair for a synchronous, single-file DB.

---

## 12. Configuration

| Setting | Env var | Default |
|---|---|---|
| Server URL the extension posts to | `PI_COST_URL` | saved file wins; unset in both ⇒ extension is inert |
| Disable automatic reporting | `PI_COST_AUTO=0` | auto enabled when URL is set |
| Request timeout, settled | `PI_COST_TIMEOUT_MS` | 5000 |
| Report debounce floor | `PI_COST_MIN_INTERVAL_MS` | 10000 |
| Shared secret header | `PI_COST_TOKEN` | unset; set it for any non-loopback deployment |
| Server port | `PI_COST_PORT` | 4870 |
| Server bind address | `PI_COST_HOST` | `127.0.0.1`; the container overrides it to `0.0.0.0` |
| Host-side port mapping | `PI_COST_BIND` | `127.0.0.1:4870:4870`; compose variable, `0.0.0.0:4870:4870` for LAN |
| Sessions directory | `PI_COST_SESSIONS_DIR` | falls back to Pi's `PI_CODING_AGENT_SESSION_DIR`, then `~/.pi/agent/sessions`; the container points it at an empty directory |
| Database path | `PI_COST_DB` | `dashboard/data/cost.db`; `/app/data/cost.db` in the container |
| Chart timezone | `PI_COST_TZ` | empty means UTC; an IANA name (`America/Denver`, `Asia/Kolkata`) buckets days, hours, and the Today window in that zone |

The extension reads `process.env` directly. A future config file
(`~/.pi/agent/extensions/pi-cost.json`) is listed as a follow-up so settings
survive without a shell profile; env vars first because they need no parser.

The server reads `process.env` and does not load a `.env` file itself, because tests
import the app factory from the same module and a file-based side effect would make the
suite depend on the developer's local config. The npm scripts pass Node's
`--env-file-if-exists=.env`, and compose supplies the container's environment. That is why
`dotenv` is not a dependency.

The server binds `127.0.0.1` for `npm start` and requires `x-pi-cost-token` when
`PI_COST_TOKEN` is set. The Docker deployment publishes a LAN address on a trusted
network; do not expose it beyond that.

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
- `npm run verify` — rescans from the current file state, then checks three things:
  session row count against the number of session files, grand-total cost against the
  sum freshly computed from the files, and each stored rollup against the sum of its own
  stored facts. Exits non-zero on any mismatch. Rescanning first matters: a running Pi
  session is appended to continuously, so comparing an older scan against a newer file
  read reports growth as if it were a scanner bug. Sessions with no usage facts are
  treated as zero, not as missing rows.
- If a session file is deleted after being ingested, the row is removed on the
  next scan (§7). Retention is therefore "as long as the files exist," which
  keeps the dashboard and Pi's own session list consistent.

### Saved settings (built after the LAN deployment made env-only setup painful)

`/pi-cost-settings` writes `~/.pi/agent/extensions/pi-cost.json` at mode 0600 with
`url`, `token`, and `auto`. Rules:

- **Saved wins, key by key.** A file value beats the environment; an env var applies only
  to a key the file omits, so `PI_COST_URL=… pi` is still a clean one-off override.
- **`token: ""` is a saved choice**, meaning "no token". Turning a secret off does not
  require deleting the file.
- **A corrupt or missing file reads as nothing saved.** A bad manual edit must not crash a
  session.
- **Reports re-read the file**, so saving an endpoint mid-session starts reporting with no
  Pi restart. That is why the report handlers take the current config at event time.
- **Non-interactive runs ignore the command.** Print, JSON, and RPC-without-dialogs modes
  have no dialogs; the command returns without touching anything, and saved settings keep
  driving reports.
- **Tokens are masked in output** (`dda4…aaaf (32 chars)`) — settings text gets read over
  shoulders and pasted into chats.
- **Test connection is non-destructive:** `GET /api/health` for reachability (host, port,
  TLS chain, proxy), then an empty-body `POST` to the ingest endpoint for the token. 401 is
  a bad secret, 400 means the request cleared the token check and the validator rejected the
  body, so a diagnostic writes nothing.

The menu has six actions; the same keys work as subcommands (`/pi-cost-settings url`).
Validation before saving rejects non-http(s) schemes, missing hosts, and a bare host with no
path, and saves an unusual path with a note that it is not `/api/ingest`.

### Deployment (decided: Docker, on a LAN host)

The server runs on its own machine, reachable on the LAN, and Pi machines report to it.
`dashboard/compose.yml` builds the image, publishes the port, mounts the database as a
named volume, and health-checks `/api/health`.

| | Behavior |
|---|---|
| Sessions scanned | `PI_COST_SESSIONS_DIR` points at an empty in-image directory, so the deployment is push-fed |
| Host-side binding | `PI_COST_BIND`; `127.0.0.1:4870:4870` for a loopback test box, `0.0.0.0:4870:4870` for LAN access |
| Inside the container | binds `0.0.0.0`, which is what makes a published port reachable |
| Writes | `x-pi-cost-token` must match `PI_COST_TOKEN` |
| Reads | open, chosen deliberately for a trusted LAN: the dashboard opens in a browser with no secret |
| Transport | plain HTTP. On a trusted LAN that is acceptable; the token rides in a header, so wire sniffers would see it. Off a trusted network, put TLS in front |

Two consequences of being push-fed, both verified by tests: a scan over a missing
directory scans nothing instead of throwing, and the missing-file sweep only deletes rows
tracked in `scan_state`, so pushed sessions survive it. Repeated pushes from the same
session update the row, since a push may replace a push; the entry-count guard only
rejects reports that are older than what is stored.

## 15. Test plan

| Level | Checks |
|---|---|
| Unit: `aggregate.js` | Fixture JSONL with all five usage-bearing entry types; asserts cost equals the sum of all five, that tool-result usage is billed, that aborted assistant usage is counted, and that a `usage`-only session (cache warm) is counted |
| Unit: scanner | Cold scan, warm scan with unchanged files skips all, changed mtime re-parses one, missing file deletes the row |
| Unit: ingest guard | Stale `entryCount` rejected; equal accepted; out-of-order arrival never lowers `cost_micros` |
| Unit: validation | Bad `schemaVersion`, negative token, non-numeric cost, oversized body, unknown key |
| Unit: cost split | A version 1 payload is refused; a missing component is refused by name; parts that do not add up to the cost are refused at both event and session level, within the rounding allowance |
| Unit: `aggregate.js` split | Fixture parts are hand-added from each `usage.cost` block and equal the stored `cost_input_micros` and friends; an unpriced model reports four zeros |
| Integration | Backfill this machine's 266 sessions, assert the grand total equals the independent Appendix A scanner run in the same second, and assert session row count equals the `.jsonl` file count |
| Integration | Chart query returns 58 day buckets with correct UTC grouping |
| Extension | Load with `pi --extension ./pi-cost.ts`; run `/pi-cost`; confirm totals match `/session` for the same session |
| Extension perf | Point `PI_COST_URL` at a sink that sleeps 5 s; confirm the next prompt is not delayed, proving the report is not awaited |
| Extension offline | Point at a dead port; confirm no notification, no error dialog, Pi unaffected |
| Scanner, push-fed | Scan with no sessions directory returns zeros instead of throwing, and leaves pushed rows in place |
| Ingest, push-fed | A push may replace a push; a push with fewer entries than the stored row is refused |
| Token gate | Writes answer 401 without the header, 200 with it; reads answer 200 with no header |
| LAN day buckets | Same range at `tzOffsetMinutes` 0, +240, and −240: totals identical, day splits differ |

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
2. **Server process management** — **decided: Docker.** `dashboard/compose.yml` runs the
   server on a LAN host with the database in a named volume. See §14.
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
| Cost formula: assistant + tool-result + usage + compaction + branch_summary | `dist/core/usage-totals.js`, `dist/core/agent-session.js:3445-3480` |
| Tool-result messages can carry usage, and Pi bills it | `dist/core/agent-session.js:3466-3471`, `docs/extensions.md` nested-call usage |
| Nested tool usage is folded into the calling tool's result `usage` | `docs/extensions.md` (custom tools) |
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
