# dashboard

Express server + SQLite + React dashboard that stores and charts Pi session cost.

**Status: design only, no code.** See [../DESIGN.md](../DESIGN.md) §4–§8, §10–§11.

## Planned layout

```
dashboard/
├── package.json
├── .env.example
├── server/
│   ├── index.js            # express bootstrap, serves web/dist in prod
│   ├── db.js               # better-sqlite3 handle + migration runner
│   ├── migrations/001_init.sql     # UP + DOWN, reversible
│   ├── ingest.js           # POST /api/ingest: validate + guarded upsert
│   ├── queries.js          # summary, daily, sessions, models
│   └── scanner/
│       ├── aggregate.js    # one session file -> { session, events }   (pure)
│       └── scan.js         # directory walk, scan_state mtime/size cache
└── web/
    ├── vite.config.js      # dev proxy /api -> :4870
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

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/ingest` | Upsert a session snapshot from the extension |
| `GET` | `/api/summary` | All-time plus today / 7d / 30d totals |
| `GET` | `/api/daily` | Time-series points, filtered by project / provider |
| `GET` | `/api/sessions` | Paginated session table, newest first |
| `GET` | `/api/sessions/:id` | One session, totals and per-entry events |
| `GET` | `/api/models` | Spend by provider and model |
| `POST` | `/api/rescan` | Run an incremental directory scan now |
| `GET` | `/api/health` | DB path, session count, last scan, schema version |

## Data model, three tables

| Table | Granularity | Why |
|---|---|---|
| `sessions` | one row per Pi session | totals, project, name, counts |
| `usage_events` | one row per usage-bearing entry | correct daily attribution for sessions that run across midnight |
| `scan_state` | one row per session file | `(mtime, size)` cache so warm scans skip unchanged files |

`daily_cost` and `model_cost` are views over `usage_events`, so rollups cannot
drift out of sync with the facts.

Money is stored as **integer micro-US dollars** (`cost_micros`), never a float.
SQLite has no DECIMAL; integers keep sums exact. Formatted to dollars in the API.

## Scan vs push

Both paths write the same row. The file is the source of truth; a push is a
snapshot of a running session. An `entry_count` monotonic guard discards stale
updates, and `last_source = 'push'` marks rows as provisional in the UI until the
next scan rewrites them from disk.

## Planned commands

| Command | Does |
|---|---|
| `npm run dev` | Express on 4870 + vite on 5173 |
| `npm run backfill` | Full scan of all session files, idempotent |
| `npm run verify` | Row count and grand total against an independent scanner |
| `npm run migrate` | Apply pending migrations |
| `npm run build` | Vite build, then Express serves the app on one port |

## Needs approval before install

`express`, `better-sqlite3` (native module, needs a compiler), `cors`, `dotenv`,
`react`, `react-dom`, `vite`, `recharts`, `concurrently`. See DESIGN.md §11.
Nothing is installed until approved.
