# pi-cost-dashboard

Charts the dollar cost of Pi coding-agent sessions over time.

**Status: design only.** See [DESIGN.md](./DESIGN.md) for the full plan. No code
has been written yet.

## Layout

| Folder | Contents |
|---|---|
| [`pi-extension/`](./pi-extension/) | Pi extension: `/pi-cost` command, reports the live session to the server |
| [`dashboard/`](./dashboard/) | Express server, SQLite database, React + Recharts dashboard |

## How it works, in one paragraph

Pi writes cost into every session file (`~/.pi/agent/sessions/**/*.jsonl`),
computed from model catalog prices. The dashboard server scans those files into
SQLite, which backfills all history. The extension pushes the session currently
running in Pi so the dashboard updates live. A React app charts daily spend with
project and model filters.
