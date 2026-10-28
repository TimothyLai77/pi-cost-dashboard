# pi-cost-dashboard

Charts the dollar cost of Pi coding-agent sessions over time.

**Status: built, all 8 phases.** The aggregator, SQLite store, backfill, read API, ingest
endpoint, React dashboard, and the Pi extension all work against real session data: 280
sessions, $65 of recorded spend, 77 passing tests. Plan and measurements in
[DESIGN.md](./DESIGN.md); run instructions in [dashboard/README.md](./dashboard/README.md).

## Layout

| Folder | Contents |
|---|---|
| [`pi-extension/`](./pi-extension/) | Pi extension: `/pi-cost` command, reports the live session to the server — built |
| [`dashboard/`](./dashboard/) | Express server, SQLite database, React + Recharts dashboard — built |

## How it works, in one paragraph

Pi writes cost into every session file (`~/.pi/agent/sessions/**/*.jsonl`),
computed from model catalog prices. The dashboard server scans those files into
SQLite, which backfills all history. The extension pushes the session currently
running in Pi so the dashboard updates live. A React app charts daily spend with
project and model filters, and clicking a day opens that day's 24 hours.

## Quick start

Local, on one machine:

```bash
cd dashboard
npm install
npm run migrate && npm run backfill   # build the database from your session history
npm run build && npm start            # app + API on http://127.0.0.1:4870
```

Then, inside Pi, run `/pi-cost-settings` → Set endpoint URL → Set report token. That is the
whole setup; the extension writes its own config file and starts reporting immediately.

## Deployment

The intended shape is the dashboard server on its own machine, reachable on the LAN, with
each Pi machine reporting its sessions to it. Containerized, with the SQLite file in a
named volume:

```bash
cd dashboard
cp .env.example .env          # set PI_COST_TOKEN and PI_COST_BIND=0.0.0.0:4870:4870
docker compose up -d --build
```

On each Pi machine, symlink the extension and set it up from inside Pi:

```bash
ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
# then in Pi:
#   /pi-cost-settings url    https://your-dashboard-host/api/ingest
#   /pi-cost-settings token  <the server's PI_COST_TOKEN>
#   /pi-cost-settings test
```

`/pi-cost-settings test` is the fastest way to find a broken deployment: it reports
reachability and the token verdict (401 = bad secret, 400 = good secret, nothing written).
Environment variables still work and apply to any key the saved file does not set.

That deployment is push-fed: the container scans nothing (`PI_COST_SESSIONS_DIR` points at
an empty directory inside the image), and every number arrives over `POST /api/ingest`.
Writes require the token, reads stay open. Details in
[dashboard/README.md](./dashboard/README.md).
