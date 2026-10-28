# pi-extension

Pi extension that reports session cost to the dashboard server. **Built** — plan and
measurements in [../DESIGN.md](../DESIGN.md) §9.

## Install

```bash
ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
export PI_COST_URL=https://pi-cost.example.net/api/ingest   # https or http, host or IP
export PI_COST_TOKEN=<the server's PI_COST_TOKEN>              # when the server sets one
```

Pi does not read the dashboard's `.env`. These variables have to be in the environment Pi
itself runs under — a shell profile, a systemd user environment — and Pi has to be started
from a shell that has them (re-source the profile, or restart the terminal) before any
report is sent. With `PI_COST_URL` unset the extension registers nothing at all and leaves
no trace, which is exactly what a dashboard full of zeros looks like.

`PI_COST_URL` accepts `http:` and `https:`. The fire-and-forget path picks `node:http` or
`node:https` by protocol: the plain module cannot speak TLS, so an https URL through it
would send plaintext to port 443 and fail quietly. Both paths unref their socket, which is
why neither is built on `fetch`.

Develop against one session without installing: `pi --extension ./pi-cost.ts`

Inert when `PI_COST_URL` is unset: an unconfigured Pi session does no network work, writes
no files, and registers nothing. With `PI_COST_TOKEN` unset it reports to a server that has
no token configured; against a token-protected server every report is refused with 401 and
logged to `~/.pi/agent/extensions/pi-cost.log`.

## Commands

| Command | Behavior |
|---|---|
| `/pi-cost` | Report this session, show its cost |
| `/pi-cost total` | All-time spend from the server |
| `/pi-cost today` / `/pi-cost week` | Server totals for a window |
| `/pi-cost off` / `/pi-cost on` | Stop / resume automatic reporting for this session |

## Reporting

| When | Awaited? | Notes |
|---|---|---|
| `/pi-cost` | Yes | You asked for it, so you get the answer |
| `agent_settled` | **No** | Pi awaits settled handlers and defers prompts while they run |
| `session_shutdown` | Yes, 2 s cap | Process exit kills in-flight requests; no prompts left to delay |

Automatic reports run only in interactive sessions. A print-mode run has no prompts to
protect, and in a deployment that scans session files the scanner picks its session up
seconds later. In a push-fed deployment — the container scans nothing — the report at
session exit is what puts a print-mode session on the dashboard, so run it with
`PI_COST_URL` set.

## The two constraints that shaped this

1. **Pi awaits `agent_settled`.** `dist/core/agent-session.js:689` awaits the handlers, and
   `:1632` defers prompts while they run. A handler that awaits a fetch to an unreachable
   server stalls your next prompt for its full timeout. So the automatic report is not
   awaited.
2. **An outstanding request keeps Node's event loop alive.** Not awaiting is not enough.
   Against a sink that sleeps 5 s per request, `pi -p` took 6.0 s; the 2 s cap did not
   help, because the unfinished background request is what kept the process alive. Fixed
   by `socket.unref()` via `node:http` (not reachable through `fetch`), plus skipping
   automatic reports outside interactive mode.

Measured, 5 samples per configuration:

| Configuration | `pi -p` elapsed |
|---|---|
| Extension absent | 986–1442 ms |
| Reporting to a healthy server | 987–1825 ms |
| 5 s sink, before the unref fix | 5985–6078 ms |
| Same 5 s sink, after the fix | 3174–3502 ms (baseline + the awaited 2 s exit cap) |

Reporting to a healthy server is indistinguishable from not reporting.

## Payload

`payload.schema.json` is the contract, version 1. Numbers and identifiers only — no
prompt text, assistant text, tool input or output, file contents, or credentials. The
server rejects unknown keys, so a future version of this extension cannot quietly start
shipping transcript content. `dashboard/server/test/extension.test.js` builds payloads
from real fixtures and requires the server's validator to accept them.

## Files

| File | Purpose |
|---|---|
| `pi-cost.ts` | The extension |
| `payload.schema.json` | Ingest contract, shared with the server |
| `tsconfig.json` | Type-check against Pi's real declarations: `/home/user/node_modules/.bin/tsc -p tsconfig.json` |
