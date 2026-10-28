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
npm test             # 86 tests
```

Opening `http://127.0.0.1:4870` after `npm run build && npm start` serves the app and
its API from one port. `npm run dev` is the editing workflow. `npm start`, `dev:server`,
and the CLIs pass Node's `--env-file-if-exists=.env`, so a local `.env` is picked up
without a dependency; the server module itself never reads a file, which keeps the test
suite independent of whoever runs it.

To watch a live session locally, install the extension
([../pi-extension/README.md](../pi-extension/README.md)) and point it at your own run:

```bash
ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
export PI_COST_URL=http://127.0.0.1:4870/api/ingest
export PI_COST_TOKEN=$(grep PI_COST_TOKEN .env | cut -d= -f2)   # only if one is set
```

## Deploy with Docker (LAN host)

The intended deployment is the server on another machine on your LAN, with Pi machines
reporting to it over HTTP. On the host machine:

```bash
cd dashboard
cp .env.example .env
openssl rand -hex 24        # paste the result as PI_COST_TOKEN in .env
# For LAN access, set the host-side binding:
#   PI_COST_BIND=0.0.0.0:4870:4870
docker compose up -d --build
docker compose ps           # "Up (healthy)"
```

What the container does and does not read:

| | |
|---|---|
| SQLite | named volume `pi-cost-data` at `/app/data/cost.db` |
| Sessions to scan | `PI_COST_SESSIONS_DIR`, which compose points at an empty `/app/no-sessions` |
| Data source | `POST /api/ingest` reports from the Pi machines |
| Writes | require `x-pi-cost-token` matching `PI_COST_TOKEN` |
| Reads | open, so the dashboard opens in a browser with no secret |

That is a push-fed deployment: nothing is read off the server host. To also scan history
that lives on the server host, mount it read-only and point the scanner at it:

```yaml
volumes:
  - pi-cost-data:/app/data
  - /home/you/.pi/agent/sessions:/data/pi-sessions:ro
# and in the environment block:
#   PI_COST_SESSIONS_DIR: /data/pi-sessions
```

On each Pi machine, point the extension at the server and give it the same secret:

```bash
export PI_COST_URL=http://your-dashboard-host:4870/api/ingest   # name or LAN IP
export PI_COST_TOKEN=<the same secret>
```

`docker compose down` keeps the volume; `docker compose down -v` deletes the database.
The image has a healthcheck that polls `/api/health` every 30 seconds.

The transport is plain HTTP, which is fine on a trusted LAN: the token rides in a header,
so anyone who can sniff the wire can read it. If this ever leaves a trusted network, put
it behind a TLS proxy and keep the port off the public interface.

## Layout

```
dashboard/
├── package.json
├── .env.example
├── Dockerfile              # build the app, run only the server
├── compose.yml             # LAN deployment: bind, token, volume, healthcheck
├── .dockerignore
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
    ├── index.html          # inline theme script runs before first paint
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── api.js
        ├── theme.js        # Auto / Light / Dark, persisted, follows the system in Auto
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
set. `npm start` binds `127.0.0.1`; the container binds `0.0.0.0` internally and the
host-side `PI_COST_BIND` in `compose.yml` decides who can reach it.

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
  `provisional: true`. The UI labels a row live when it is push-sourced *and* its last
  activity is within 15 minutes, which stays meaningful in a push-fed deployment where
  every row is push-sourced. `upsertSession` refuses to let a push overwrite scanned
  numbers, and refuses a push with fewer entries than the row already has, so a late
  report from an older snapshot cannot roll a session's cost back. Repeated pushes from a
  running session do update it, which is how a session's numbers climb in real time.
- **Ingest validation rejects unknown keys.** A future version of the extension cannot
  quietly start sending transcript content, and a client that sends text gets a 400 naming
  the field.
- **Day buckets follow the viewer.** `tzOffsetMinutes` shifts the daily buckets; the app's
  Local days toggle sends the browser's offset. Totals are identical either way — only the
  day a session is billed to moves.
- **Two palettes, one token set.** Light is ink on cool paper, dark is "Ledger slate": the
  same ledger printed on `#14171a` with the money accent lifted to `#e0873d`. The live
  accent changes character between them — cyan in light, lilac in dark — because cyan on a
  dark slate reads as a hyperlink, and lilac keeps "this session is running now" from
  competing with the amber that carries money. The masthead's 2px rule has its own token
  (`--rule-accent`): full ink on dark slate is 14.8:1 and reads as a lit line, so dark
  softens it to silver at 9.4:1. Every text pair clears WCAG AA in **both** palettes —
  light body 16.1:1, secondary 7.0:1, eyebrow 4.60:1; dark body 14.8:1, secondary 9.4:1,
  eyebrow 5.42:1 — and chart fills clear 3:1 against the page. The light eyebrow needed a
  fix to get there: `--ink-faint` was `#7c858f` at 3.42:1, under AA for 11px uppercase
  labels, so it is now `#67707a`, the lightest value that clears 4.5:1.
  `theme.js` owns the setting (Auto follows the operating system, Light and Dark pin it,
  choice stored in localStorage), and an inline script in `index.html` applies it before
  the first paint so a reload in dark mode does not flash light first. Form controls get
  `color-scheme`, so the selects and checkbox render native to the palette.
