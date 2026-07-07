# Sigils load test

Measures whether the backend can sustain **N concurrent users pushing sigils every M seconds**
without tripping over the AI quota. Zero dependencies — plain Node ≥ 20.

## What it exercises

Each virtual user gets its **own account and MCP token** (register → verify → mint), then behaves
exactly like a real agent: every interval it `POST`s an incremental deployed-state change to
`/api/chats/:chatId/deployments`. On the server, every push runs **one Gemini (Vertex AI) call**
(the stateviz agent that redraws the sigil) plus the D2 → SVG render — that Gemini call is the
part that draws from your GCP quota, and the reason this test exists.

The server-side protection under test lives in `server/agents/shared/limiter.js`:

- at most `LLM_MAX_CONCURRENT` (default 16) simultaneous Gemini calls — bursts queue FIFO
  instead of hammering Vertex's dynamic shared quota;
- transient `429 RESOURCE_EXHAUSTED` / `503` errors retry with exponential backoff.

## Run it

**1. Start a scratch backend** (never the dev server on `:3001`, never production — the test
creates accounts and data):

```bash
cd server
NODE_ENV=production PORT=3105 MAX_USERS=200 \
PERSIST_DIR=/tmp/loadtest-persist AUTH_PERSIST_DIR=/tmp/loadtest-persist/auth \
npm start
```

Notes on that env:
- `NODE_ENV=production` → real multi-user auth + per-user MCP tokens (dev mode has neither).
- No `SMTP_*` → verification codes come back in the register response, which the setup uses.
- GCP credentials (`GCP_PROJECT_ID`, ADC) come from `server/.env.local` as usual — the Gemini
  calls are **real** so the quota measurement is real.

**2. Run the test** (from the repo root):

```bash
# Dry run first — no Gemini calls, no quota spent; validates auth/ingest/render mechanics
node loadtest/run.js --users 20 --interval 5 --duration 60 --no-ai

# The real thing: 20 users, one push each every 30s, for 5 minutes
node loadtest/run.js --users 20 --interval 30 --duration 300
```

**3. Clean up:** stop the scratch server and `rm -rf /tmp/loadtest-persist`.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--base` | `http://127.0.0.1:3105` | Target server (refuses `:3001` and sigilum.cloud) |
| `--users` | `20` | Concurrent virtual users |
| `--interval` | `30` | Seconds between pushes, per user |
| `--duration` | `300` | Total run time in seconds |
| `--no-ai` | off | Pushes crafted to skip the Gemini calls (empty inventory) |

Exit code `0` = every request succeeded, `1` = failures (each one logged with its body).

## Reading the results

- **failed = 0** is the pass condition. With the limiter in place, a burst beyond
  `LLM_MAX_CONCURRENT` shows up as *higher p95/p99 latency* (calls waiting for a slot — watch
  the server log's `[llm] call waited …ms for a slot` lines), never as 429 errors.
- **`[llm] transient error … retrying`** in the server log means Vertex did throttle and the
  backoff absorbed it — expected occasionally under dynamic shared quota, fine as long as the
  request still succeeds.
- **p50 vs p95 gap** growing over the run = queue building up faster than it drains. Capacity
  is `LLM_MAX_CONCURRENT / avg_call_seconds` pushes per second; demand is `users / interval`.
  A stateviz generation takes **~25–30s on Gemini Flash**, so 20 users every 30s (~0.67/s)
  needs ~16–20 slots — that sizing is why the default cap is 16.

## Example output (real run, 2026-07-07)

```
Sigils load test → http://127.0.0.1:3105
  20 users · 1 push every 30s each · 180s total · real Gemini calls (1 per push)

Provisioning users (register → verify → MCP token)…
  provisioned 20/20 users
  … 150s left · 2 pushes (0 failed) · p95 27188ms
  … 90s left · 39 pushes (0 failed) · p95 51307ms
  … 15s left · 88 pushes (0 failed) · p95 40306ms

── POST /api/chats/:id/deployments — 20u/30s ─────
  requests     116
  ok           116
  failed       0
  throughput   0.48 req/s
  latency p50  28.0s
  latency p95  48.4s
  latency p99  62.5s
  latency max  74.2s
  wall time    242.6s
──────────────────────────────────────────────────
```

During that run Vertex returned one real `429 RESOURCE_EXHAUSTED`; the limiter's backoff
retried it and the request still succeeded — that's the `[llm] transient error … retrying`
line in the server log doing its job. p50 ≈ 28s is the raw Gemini generation time for a
stateviz diagram, not queueing: it's the healthy baseline, not a regression.

For contrast, the same run with `LLM_MAX_CONCURRENT=4` saturated: latencies climbed
monotonically past 2 minutes and one request died on the 120s queue timeout — that's what
under-provisioned capacity looks like in this report.

## Layout

```
loadtest/
  run.js            CLI entry point (flags, virtual-user loop, report)
  lib/setup.js      account + MCP-token provisioning per virtual user
  lib/payloads.js   evolving synthetic AWS architectures (one mutation per push)
  lib/metrics.js    latency percentiles + the summary table
```
