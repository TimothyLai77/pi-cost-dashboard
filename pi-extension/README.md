# pi-extension

Pi extension that reports session cost to the dashboard server.

**Status: design only, no code.** See [../DESIGN.md](../DESIGN.md) §9.

## Planned files

| File | Purpose |
|---|---|
| `pi-cost.ts` | The extension. `/pi-cost` command, `agent_settled` and `session_shutdown` reporters |
| `payload.schema.json` | Versioned ingest contract. Server validates incoming bodies against it |

## Planned commands

| Command | Behavior |
|---|---|
| `/pi-cost` | Report this session, show its cost |
| `/pi-cost total` | All-time spend from the server |
| `/pi-cost today` / `/pi-cost week` | Server totals for a window |
| `/pi-cost off` | Disable automatic reporting for this session |

## Two constraints that shape the implementation

1. Pi **awaits** `agent_settled` handlers and defers prompts while they run, so
   the automatic report is fire-and-forget and never awaited.
2. `ctx.sessionManager` has no `getSessionStats()`, so the extension computes
   totals from `getEntries()` — all entries, all branches, matching Pi's own
   formula. Measured at 0.27 ms on the largest session on this machine.

## Install target

```
~/.pi/agent/extensions/pi-cost.ts        # symlink from this folder during development
pi --extension ./pi-cost.ts              # load directly while developing
```

Inert when `PI_COST_URL` is unset: an unconfigured Pi session does no network work.
