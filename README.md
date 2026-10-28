# pi-cost-dashboard

Charts the dollar cost of Pi coding-agent sessions over time.

**Status: Phases 1–4 built.** Aggregator, SQLite schema and backfill, read API, and the
React dashboard are working against real session data. The ingest endpoint and the Pi
extension are next. Full plan in [DESIGN.md](./DESIGN.md); run instructions in
[dashboard/README.md](./dashboard/README.md).

Built so far, on this machine's 265 session files: $63 of recorded spend, 59 days with
activity, 20 models, 50 passing tests.

## Layout

| Folder | Contents |
|---|---|
| [`pi-extension/`](./pi-extension/) | Pi extension: `/pi-cost` command, reports the live session to the server — planned |
| [`dashboard/`](./dashboard/) | Express server, SQLite database, React + Recharts dashboard — built |

## How it works, in one paragraph

Pi writes cost into every session file (`~/.pi/agent/sessions/**/*.jsonl`),
computed from model catalog prices. The dashboard server scans those files into
SQLite, which backfills all history. The extension pushes the session currently
running in Pi so the dashboard updates live. A React app charts daily spend with
project and model filters.
