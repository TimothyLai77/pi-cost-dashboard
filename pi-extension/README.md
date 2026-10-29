# pi-extension

Pi extension that reports session cost to the dashboard server. **Built** — plan and
measurements in [../DESIGN.md](../DESIGN.md) §9.

## Install

```bash
ln -s ~/git/pi-cost-dashboard/pi-extension/pi-cost.ts ~/.pi/agent/extensions/pi-cost.ts
```

Then, inside Pi, run `/pi-cost-settings` → Set endpoint URL → Set report token. Nothing
else to install: Pi writes its own config, and reports start immediately.

Develop against one session without installing: `pi --extension ./pi-cost.ts`

### Settings file

`/pi-cost-settings` saves to `~/.pi/agent/extensions/pi-cost.json` at mode 0600:

```json
{ "url": "https://pi-cost.example.net/api/ingest", "token": "…", "auto": true }
```

Saved settings win. An environment variable applies only to a key the file does not set, so
a saved setup works in every shell and `PI_COST_URL=… pi` is still a clean one-off
override against a test server. Tuning values (`PI_COST_TIMEOUT_MS`,
`PI_COST_MIN_INTERVAL_MS`, `PI_COST_SHUTDOWN_TIMEOUT_MS`, `PI_COST_AUTO`) stay
environment-only; they are not worth a menu entry.

With no endpoint from the file or the environment, the extension does nothing at all: no
network calls, no file writes, nothing to notice. `PI_COST_URL` accepts `http:` and
`https:`; the fire-and-forget path picks `node:http` or `node:https` by protocol, because
the plain module cannot speak TLS, and both variants unref their socket — which is why
neither is built on `fetch`.

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
| `/pi-cost-settings` | Menu: show, endpoint URL, report token, auto on/off, test connection, clear |
| `/pi-cost-settings url\|token\|auto\|test\|show\|clear` | Skip the menu, go straight there |

The settings menu works only where Pi has dialogs. In print, JSON, and RPC-without-dialogs
runs it does nothing, and whatever is already saved keeps being used for reporting.

`Test connection` is non-destructive: `GET /api/health` proves the host, port, TLS chain,
and proxy, then an empty-body `POST` to the ingest endpoint proves the token — 401 means
the secret is wrong, 400 means the request cleared the token check and the validator
rejected the body, so nothing is written. Tokens are masked in every listing
(`dda4…aaaf (32 chars)`).

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

`payload.schema.json` is the contract, version 2. Numbers and identifiers only — no
prompt text, assistant text, tool input or output, file contents, or credentials. The
server rejects unknown keys, so a future version of this extension cannot quietly start
shipping transcript content. `dashboard/server/test/extension.test.js` builds payloads
from real fixtures and requires the server's validator to accept them.

Version 2 added the four parts of every bill — `costInputMicros`, `costOutputMicros`,
`costCacheReadMicros`, `costCacheWriteMicros` — on each event and in `totals`. Pi's pricing
pass writes those four next to the total in every usage block, so the extension reads them
rather than computing them. The server accepts version 2 only, so the extension and the
server deploy together: a Pi running the older extension gets
`unsupported_schema_version` back and stops self-reporting until it is reloaded.

## Files

| File | Purpose |
|---|---|
| `pi-cost.ts` | The extension |
| `payload.schema.json` | Ingest contract, shared with the server |
| `tsconfig.json` | Type-check against Pi's real declarations: `/home/user/node_modules/.bin/tsc -p tsconfig.json` |
