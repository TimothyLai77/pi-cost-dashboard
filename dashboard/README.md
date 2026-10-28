# dashboard

Express server + SQLite + React dashboard that stores and charts Pi session cost.

All eight phases are built: aggregator, schema and backfill, read API, React app, ingest
endpoint, and the Pi extension. Full plan in [../DESIGN.md](../DESIGN.md).

## Run it

```bash
cd dashboard
npm install
npm run migrate      # create data/cost.db
npm run backfill     # scan every session file, prints totals
npm run verify       # check the database against the files, exits non-zero on mismatch
npm run dev          # Express on 4870 + vite on 5173 (proxies /api)
npm run build        # bundle web/ into web/dist
npm start            # serve API and built app from 4870
npm test             # 77 tests
```

Opening `http://127.0.0.1:4870` after `npm run build && npm start` serves the app and
its API from one port. `npm run dev` is the editing workflow.

To see a live session on the dashboard, install the extension
([../pi-extension/README.md](../pi-extension/README.md)) and point it here:

```bash
ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
export PI_COST_URL=http://127.0.0.1:4870/api/ingest
```

## Layout

```
dashboard/
├── package.json
├── .env.example
├── vite.config.js
├── server/
│   ├── index.js            # express app; createApp() is exported for tests
│   ├── db.js               # better-sqlite3 handle + migration runner
│   ├── upsert.js           # guarded session upsert, shared by scan and ingest
│   ├── queries.js          # summary, daily, sessions, models, filters, health
│   ├── migrations/         # numbered .sql with .down.sql partners
│   ├── scanner/
│   │   ├── aggregate.js    # one session file -> { session, events }   (pure)
│   │   └── scan.js         # directory walk + (mtime, size) cache
│   ├── cli-aggregate.js    # cost rollup for one file
│   ├── cli-migrate.js      # migrate / --down / --status
│   ├── cli-backfill.js     # scan the directory, print totals
│   ├── cli-verify.js       # database vs files, non-zero exit on mismatch
│   └── test/               # node:test suites + fixtures
└── web/
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── api.js
        ├── styles.css
        └── components/
            ├── SummaryCards.jsx
            ├── CostChart.jsx
            ├── ModelBreakdown.jsx
            └── SessionTable.jsx
```

## API

| Method | Path | Status |
|---|---|---|
| `GET` | `/api/summary?days=7` | today / 7d / 30d / all-time totals |
| `GET` | `/api/daily?from&to&cwd&provider&tzOffsetMinutes` | chart points, gap-filled |
| `GET` | `/api/sessions?limit&offset&cwd&provider&sort` | session list |
| `GET` | `/api/sessions/:id` | one session with its usage facts |
| `GET` | `/api/models` | spend by provider and model |
| `GET` | `/api/filters` | project and provider values for the controls |
| `GET` | `/api/health` | counts, schema version, last scan |
| `POST` | `/api/rescan` | force a full rescan |
| `POST` | `/api/ingest` | extension report: validated, provisional, idempotent |

Money is integer micro-US dollars (`costMicros`) plus a formatted `costUsd` string.
Reads are open; the two POST routes require `x-pi-cost-token` when `PI_COST_TOKEN` is
set. The server binds `127.0.0.1`.

## Data model

| Table | Granularity | Why |
|---|---|---|
| `sessions` | one row per Pi session | rollups, project, name, counts |
| `usage_events` | one row per usage-bearing entry | a session spanning midnight bills the days it ran on |
| `scan_state` | one row per session file | `(mtime, size)` cache; unchanged files are skipped |

`daily_cost` and `model_cost` are views over `usage_events`, so rollups cannot drift out
of sync with the facts. `npm run verify` checks row counts, grand total, and each
rollup against the sum of its own facts.

## Notes from building this

- **Warm scans are fast.** 21 ms for 265 sessions with the cache; 738 ms cold.
- **Zero-cost days are real.** Most usage here is local models with no catalog price, so
  the chart draws token volume as a background band under the cost bars rather than
  leaving a flat zero line that reads as missing data.
- **The sessions tree contains non-session JSONL.** Pi writes subagent transcripts under
  `subagent-artifacts`; the walk skips those directories and the header check rejects
  the rest.
- **The Recharts bundle is split from the app shell** — 221 kB app, 397 kB chart library
  (116 kB gzipped), so the shell revalidates quickly.
- **Provisional rows are marked, not trusted.** A push from the extension is a snapshot of
  a running session, so `last_source = 'push'` marks the row and the API reports
  `provisional: true`. The UI labels those rows live. The next scan, which runs every 60 s,
  replaces them with file-derived numbers, and `upsertSession` refuses to let a push
  overwrite scanned numbers.
- **Ingest validation rejects unknown keys.** A future version of the extension cannot
  quietly start sending transcript content, and a client that sends text gets a 400 naming
  the field.
- **Day buckets follow the viewer.** `tzOffsetMinutes` shifts the daily buckets; the app's
  Local days toggle sends the browser's offset. Totals are identical either way — only the
  day a session is billed to moves.
