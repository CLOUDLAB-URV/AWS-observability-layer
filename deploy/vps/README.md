# VPS deployment

Self-contained runtime stack for the Sigilum app. It runs both Docker Hub images
behind a single proxy with **automatic HTTPS** and **auto-redeploys whenever a new image is
published**.

```
                       ┌──────── Caddy (edge proxy) ────────┐
  https://$DOMAIN ─▶ :443  ─▶ frontend (nginx: SPA + proxy /api,/ws,/ws-visualizer ─▶ backend)
  http://$DOMAIN  ─▶ :80   ─▶ 308 redirect to https
                       └────────────────────────────────────┘
  watchtower ── polls Docker Hub every 30s ── new :latest digest ─▶ pull + recreate
```

- **Caddy** serves the whole app at `https://$DOMAIN`, obtaining and renewing a Let's Encrypt
  certificate automatically. Set `DOMAIN` (and optionally `ACME_EMAIL`) in `.env`.
- **frontend** talks to the backend same-origin; its nginx already proxies `/api`, `/ws` and
  `/ws-visualizer` to `backend:3001`, so the whole app (incl. the API) is reachable under the
  one domain — e.g. `https://$DOMAIN/api/...`.
- **watchtower** watches only the labeled containers (frontend/backend) and redeploys them
  when their `:latest` image changes on Docker Hub.

### DNS / firewall (required for HTTPS)

Before `up -d`: point a DNS **A record** (and AAAA if you have IPv6) for `sigilum.cloud`
at the server's public IP, and make sure inbound **ports 80 and 443** are open. Port 80 is
needed for the ACME challenge and the HTTP→HTTPS redirect.

## Files

Two config buckets — **what the app runs with** (`.env`) and **how you deploy it** (`.env.deploy`):

| File                  | Purpose                                                            |
|-----------------------|-------------------------------------------------------------------|
| `compose.yaml`        | The 4 services (backend, frontend, caddy, watchtower).            |
| `Caddyfile`           | Edge proxy + automatic HTTPS for `$DOMAIN` → frontend.            |
| `.env`                | **All app config + secrets** — images, domain, modes, SMTP, keys (gitignored). |
| `.env.example`        | Template for `.env`.                                              |
| `.env.deploy`         | Local-only `push-deploy.sh` target — SSH host + path (gitignored). |
| `.env.deploy.example` | Template for `.env.deploy`.                                       |

The real files (`.env`, `.env.deploy`) are **gitignored**; commit only the `*.example` templates —
`cp` each to the real name and fill it in.

**The images are generic** — nothing is baked in, anyone can run them. Everything the running stack
needs lives in one file:

**`.env` (gitignored) — Docker Compose auto-loads it for `${VAR}` interpolation, and the backend
gets every key via `env_file: .env`:**
- `IMAGE_BACKEND` / `IMAGE_FRONTEND` → used by compose.
- `DOMAIN` / `ACME_EMAIL` → the HTTPS domain Caddy serves and the Let's Encrypt account email.
- `APP_URL` → public base URL (used to mark session cookies `Secure` under https).
- `MAX_USERS` → how many accounts may register before new logins are blocked.
- `AGENT_ENABLED` / `DESIGN_ENABLED` → which modes are available. **A mode is enabled unless
  set to `false`.** These control **both the UI and the API** (the frontend reads them at
  runtime from `GET /api/config`), so flipping one then re-applying changes both sides with no
  image rebuild.
- **Secrets:** `SESSION_SECRET` (signs session cookies), `SMTP_HOST/PORT/USER/PASS` + `MAIL_FROM`
  (email verification codes), `GCP_PROJECT_ID` / `CLOUD_ML_REGION` (only for Design). There is
  **no MCP token here** — each user generates their own from the UI (Agent → Deployed state).
- `LLM_MAX_CONCURRENT` → cap on simultaneous Gemini calls (default 16 — sustains ~20 users
  pushing sigils every 30s). Bursts beyond the cap queue FIFO instead of hammering Vertex's
  shared quota; transient 429s retry with backoff. Load-test with `node loadtest/run.js`
  (see `loadtest/README.md`).

> **Design & Deploy** is `false` by default: enabling it needs `uv`/python + AWS credentials
> that aren't in the image (the Design tab would appear but its AWS deploy would fail). Set
> `DESIGN_ENABLED=true` only once the image is made Design-capable.

## Login (internal: email + username + password)

Auth is **on by default**. Users sign up with **username + email + password** and confirm their
email with a **6-digit code**; then they log in with email-or-username + password. (Set
`AUTH_DISABLED=true` in `.env` to run open as a single "dev" user, e.g. for local poking.)

**Email delivery (verification codes)** — set SMTP in `.env`:
- `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS / 465 TLS), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
- Gmail works with an **App Password** (`SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`).
- **No SMTP set?** The backend logs the code to its output instead of emailing it
  (`docker compose logs backend`) — handy for local dev; not for production.

`MAX_USERS` caps how many accounts can register. Users are isolated: each sees only its own
sessions/diagrams and generates its own MCP tokens. Accounts, sessions, tokens and deployed-state
all live in the `app_data` volume, so they **survive container recreation / Watchtower updates**.

## Admin accounts

Accounts with the `admin` role get an **"Admin view"** entry in their profile menu: a read-only
panel listing every account, its sigils, last login and usage stats. The role can **only** be
granted or revoked from the server via the operator CLI — there is deliberately no web/API way to
change roles.

The persistence volume is mounted only in the backend container, so run the CLI inside it:

```bash
docker compose exec backend npm run admin -- list                       # table of all accounts
docker compose exec backend npm run admin -- grant alice@example.com    # promote (asks y/N)
docker compose exec backend npm run admin -- revoke alice --yes         # demote, no prompt
docker compose exec backend npm run admin -- stats                      # accounts/verified/admins
```

- Identifiers are an **email or username** (case-insensitive); the CLI echoes the matched account
  before asking for confirmation, so a typo can't silently promote the wrong person.
- Role changes apply on the target user's **next request** — no restart, no re-login needed.
- Every grant/revoke appends a JSONL line to the audit log:
  `docker compose exec backend cat persistence/admin-audit.log`.

## Deploy on a machine

Requires Docker Engine + the Compose plugin.

```bash
# 1. Get the files (clone the repo, or scp just this folder)
git clone <repo-url> && cd <repo>/deploy/vps
#   or:  scp -r deploy/vps vps:~/aws-architect && ssh vps; cd ~/aws-architect

# 2. Config + secrets (copy the template, then fill it in)
cp .env.example .env                 # DOMAIN, ACME_EMAIL, APP_URL, MAX_USERS, modes, images, secrets
#    Make sure DNS for $DOMAIN points here and ports 80/443 are open (see above).

# 3. Run (stays up across reboots; restart: unless-stopped)
docker compose up -d

# 4. Check
docker compose ps                          # backend + frontend should be "healthy"
docker compose logs -f caddy               # watch it obtain the Let's Encrypt cert
curl https://sigilum.cloud/health   # {"ok":true}  (once the cert is issued)
```

Open `https://sigilum.cloud/` for the app; the **Sigils** tab connects over a
secure `wss://` WebSocket automatically.

## Deploy from your machine (one command, with rollback)

Instead of doing the steps above by hand, push this whole folder to the VPS and apply it in one
transactional step from your laptop:

```bash
cd deploy/vps
cp .env.deploy.example .env.deploy   # set SSH_TARGET (e.g. "vps") and REMOTE_DIR (absolute path)
./push-deploy.sh                     # upload + apply + health-check on the VPS
./push-deploy.sh --dry-run           # preview what would upload; touches nothing on the VPS
```

What it does: `rsync`s the folder to `${REMOTE_DIR}.staging` on the VPS (including your local
`.env`, which **overwrites** the server's), then runs a transaction there:

- **Success** → the new stack is live and `backend`+`frontend` report healthy. It stays deployed.
- **Failure** (apply error, or not healthy in 90s) → **automatic rollback**:
  - if a deployment was **already running**, the previous one is **restored untouched** — your
    data and certificates (named volumes) are never deleted;
  - if it was a **fresh install**, the failed stack, its volumes, and the folder are removed, so
    the VPS is left exactly as it was (clean).

`.env.deploy` is local-only (gitignored) and is never uploaded. Persistence survives because data
lives in named volumes (`app_data`, `caddy_data`), not in the folder.

## Auto-update

Watchtower checks Docker Hub every 30s. When CI pushes a new `:latest` (backend or frontend),
it pulls and recreates just that container — no manual step. Watch it:

```bash
docker compose logs -f watchtower
```

## Apply config changes (`.env`)

After editing `.env` (domain, modes, `MAX_USERS`, SMTP/secrets, image names…) **on the server**,
apply it with the helper script:

```bash
./apply.sh            # re-applies the stack; recreates only the services whose config changed
./apply.sh --force    # last resort: force-recreate everything (if a change isn't auto-detected)
```

It validates the config first (so a typo never disturbs the live stack), then runs
`docker compose up -d`. Because Compose hashes each service's resolved env (the `.env`
interpolation and the backend's `env_file: .env`), it recreates **only** what actually changed —
idempotent (no changes → nothing happens). A backend env change recreates just the backend (a few
seconds; the frontend/SPA keeps serving); a `Caddyfile` change is hot-reloaded with **zero
downtime**. `.env` (with its secrets) stays only on the server (gitignored).

> Scope: `apply.sh` applies local config only. **Image** updates are handled by Watchtower.

## Operations

```bash
docker compose logs -f backend                # app logs
docker compose ps                             # service status
docker compose down                           # stop everything (volumes kept)
```

## Notes

- **Public images** need no registry login. If you make the Docker Hub repos private, mount
  your credentials into watchtower: add `- ~/.docker/config.json:/config.json:ro` under its
  `volumes` (and `docker login` on the host once).
- **HTTPS / certificates:** Caddy gets and renews the cert for `$DOMAIN` automatically; certs
  persist in the `caddy_data` volume across restarts. If issuance fails, it's almost always DNS
  not pointing here yet or port 80/443 blocked — check `docker compose logs caddy`. To change the
  domain, edit `DOMAIN` in `.env` and `docker compose up -d`.
- **Extra hostnames** (e.g. a dedicated `api.` subdomain) can be added as more site blocks in
  `Caddyfile`; today everything is served under the one `$DOMAIN`.
- **MCP tokens** are generated per user in the UI (Sigils → Connect agent) after logging in;
  there is no shared token to configure on the server. The user pastes the generated `viz_…`
  value into their MCP server's `SIGILUM_TOKEN`.
