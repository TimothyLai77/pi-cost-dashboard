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
npm test             # 107 tests
```

Opening `http://127.0.0.1:4870` after `npm run build && npm start` serves the app and
its API from one port. `npm run dev` is the editing workflow. `npm start`, `dev:server`,
and the CLIs pass Node's `--env-file-if-exists=.env`, so a local `.env` is picked up
without a dependency; the server module itself never reads a file, which keeps the test
suite independent of whoever runs it.

To watch a live session locally, install the extension
([../pi-extension/README.md](../pi-extension/README.md)) and configure it from inside Pi:

```bash
ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
# then in Pi:  /pi-cost-settings   → Set endpoint URL → http://127.0.0.1:4870/api/ingest
#                               → Set report token (copy it from .env if one is set)
#                               → Test connection
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

On each Pi machine, symlink the extension and configure it with `/pi-cost-settings` —
endpoint URL, then report token, then Test connection. The saved file is authoritative; a
one-off `PI_COST_URL=… pi` still works for keys the file does not set.

`docker compose down` keeps the volume; `docker compose down -v` deletes the database.
The image has a healthcheck that polls `/api/health` every 30 seconds.

The transport is plain HTTP, which is fine on a trusted LAN: the token rides in a header,
so anyone who can sniff the wire can read it. If this ever leaves a trusted network, put
it behind a TLS proxy and keep the port off the public interface.

### If you publish it behind a domain

Putting the dashboard on a hostname with a TLS proxy is a reasonable way to reach it, and
the extension speaks `https:` fine. Two consequences of publishing it beyond a LAN:

- **Open reads become public reads.** The API is open by design, so anyone who can name the
  host can read your spend, project paths, session ids, and model names. Restrict the path
  at the proxy (IP allowlist, basic auth, a wire guard), or gate reads in the app.
- **The port behind it does not need to be published to all interfaces.** Keep
  `PI_COST_BIND=127.0.0.1:4870:4870` and let the proxy — which runs on the same host — talk
  to loopback. Publishing `0.0.0.0` is only for direct LAN access.

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
| `GET` | `/api/summary?days=7` | today / 7d / 30d / all-time totals, with the cost split |
| `GET` | `/api/daily?from&to&cwd&provider&subagents` | chart points, gap-filled |
| `GET` | `/api/hourly?day&cwd&provider&subagents` | one day's 24 hours, zero-filled |
| `GET` | `/api/sessions/:id` | one session with its usage facts |
| `GET` | `/api/models` | spend by provider and model |
| `GET` | `/api/flows?metric&limit&from&to&cwd&provider&subagents` | model→project bands: nodes and links, top `limit` per side with an `all other` roll-up |
| `GET` | `/api/filters` | project and provider values for the controls |
| `GET` | `/api/health` | counts, schema version, last scan |
| `GET` | `/api/config` | zone the server buckets in, its offset label, and where the setting came from |
| `POST` | `/api/rescan` | force a full rescan |
| `POST` | `/api/ingest` | extension report: validated, provisional, idempotent |

Money is integer micro-US dollars (`costMicros`) plus a formatted `costUsd` string.
Reads are open; the two POST routes require `x-pi-cost-token` when `PI_COST_TOKEN` is
set. `npm start` binds `127.0.0.1`; the container binds `0.0.0.0` internally and the
host-side `PI_COST_BIND` in `compose.yml` decides who can reach it.

`/api/summary`, `/api/daily` and `/api/hourly` also carry `costBreakdown` next to every
cost figure: `input`, `output`, `cacheRead` and `cacheWrite`, each a `{ costMicros, costUsd }`
pair. Those are the four parts of the bill Pi reports, so the page can show what the money
went to, not only how much it was. A bucket with no spend has four zero parts.

`/api/flows` answers the question the ledger panels cannot: which model's money landed in
which project. It returns `nodes` (models on the left, projects on the right) and `links`
(one per pair) with each band carrying its own `costBreakdown`. `metric=cost` sizes bands in
micro-dollars, `metric=tokens` sizes them in tokens. Only the top `limit` (default 6) models
and top `limit` projects get a node of their own and the tail is rolled into an `all other`
node that carries the full totals of what it absorbed; `dropped.rolled` counts the identities
folded away, `dropped.flows` counts the pairs with none of the chosen metric, and `totals`
always describes the whole filtered window — so the page can say how much of the bill the
drawing covers instead of implying it is the whole bill.

Every aggregate also takes `subagents=1` (default, count nested sessions) or
`subagents=0` (only what each session paid directly). A subagent is billed as its
own session file and again inside its parent's tool-result usage, so totals count
both by default; the session list marks nested rows with a `subagent` tag.

Token figures are cumulative across model calls, not context size: a long session re-read its
cached context on every call, so cache reads dominate the total — today's 114M tokens on this
machine are 113M cache reads, priced at zero, over $14.47 of spend. Every place that shows a
token total also shows the split into cache read, input, output, and cache write: the summary
strip, the session list, the chart tooltips, and the model ledger.

The money in the summary strip splits the same way, and the charts carry it too: each day bar
and each hour bar is stacked in `out · in · cache read · cache write`, and the tooltip spells
the four out in dollars above the token breakdown. Each summary cell (today, 7 days, 30 days,
all time) draws the same four as a thin 100% stacked strip under its total, so the shape of a
bill is visible at a glance — a day that was all completion tokens and a month that paid for
prompt re-reads look different. Each part gets its own hue: burnt orange for `out`, mustard
for `in`, blue for cache reads, teal for cache writes. Warm is text you pay for per token,
cool is the machine's own context traffic; inside each pair the parts are separated by hue
rather than lightness, because lightness steps are hard to tell apart in a four-wide stack.
All four parts are
always shown, zeros included — a locally hosted model is priced at zero, and "$0.00" four
times is the honest label for a busy free window. Hover for the exact micro-dollar figures;
each part is rounded for display, so the four can land a cent away from the window's total.

Below the model ledger, **Money from model to project** draws the spend as a flow diagram:
models on the left, projects on the right, one band per pair, width = the money that pair
billed. Bands are colored by model on a seven-hue ramp (`--flow-1` … `--flow-7`) that is
deliberately separate from the four cost hues — in the charts a color means "which part of
the bill", here it means "which model", and sharing hues between the two would make one
color say two things. Project nodes are neutral, so color is the model and position is the
project. The **Tokens** button re-sizes every band in tokens, which is a different picture:
the model that moved 746M tokens on this machine billed $0.00, so the money view does not
draw it at all and the token view draws it as the widest node on the page.

## Timezone

`PI_COST_TZ` sets the zone the dashboard buckets in: the day bars, the 24 hour labels in
the drill-down, and the Today / 7-day / 30-day windows. Use an IANA name:

```bash
PI_COST_TZ=America/Denver   # daylight time is handled across the whole chart range
PI_COST_TZ=Europe/Berlin
PI_COST_TZ=Asia/Kolkata     # half-hour and 45-minute offsets work too
# unset, or empty, means UTC
```

Stored timestamps stay UTC; only the buckets change. The page names the zone it used in the
chart legend and the hourly note, so a screenshot says which clock its bars
are on. There is no per-viewer picker: the server computes the buckets, so every screen
shows the same answer.

## Data model

| Table | Granularity | Why |
|---|---|---|
| `sessions` | one row per Pi session | rollups, project, name, counts |
| `usage_events` | one row per usage-bearing entry | a session spanning midnight bills the days it ran on |
| `scan_state` | one row per session file | `(mtime, size)` cache; unchanged files are skipped |

`daily_cost` and `model_cost` are views over `usage_events`, so rollups cannot drift out
of sync with the facts. `npm run verify` checks row counts, grand total cost, grand total
tokens, and each rollup against both its own facts and the session file it came from.

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
