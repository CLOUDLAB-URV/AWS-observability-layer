# VPS deployment

Self-contained runtime stack for the AWS Architect Web app. It runs both Docker Hub images
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

Before `up -d`: point a DNS **A record** (and AAAA if you have IPv6) for `diagrammer.alejandropozo.com`
at the server's public IP, and make sure inbound **ports 80 and 443** are open. Port 80 is
needed for the ACME challenge and the HTTP→HTTPS redirect.

## Files

| File           | Purpose                                                      |
|----------------|-------------------------------------------------------------|
| `compose.yaml` | The 4 services (backend, frontend, caddy, watchtower).      |
| `Caddyfile`    | Edge proxy + automatic HTTPS for `$DOMAIN` → frontend.      |
| `.env`         | **The single source of config** — images, domain, modes, secrets (already filled in). |

**The images are generic** — nothing is baked in, anyone can run them. All config for this
deployment lives in the one `.env`:

- `IMAGE_BACKEND` / `IMAGE_FRONTEND` → used by compose.
- `DOMAIN` / `ACME_EMAIL` → the HTTPS domain Caddy serves and the Let's Encrypt account email.
- `AGENT_ENABLED` / `DESIGN_ENABLED` → which modes are available. **A mode is enabled unless
  set to `false`.** These control **both the UI and the API**: the frontend fetches them at
  runtime from `GET /api/config`, so flipping one here (then `docker compose up -d`) changes
  both sides with no image rebuild.
- `VISUALIZER_TOKEN` (the MCP shared secret), and `GCP_PROJECT_ID` / `CLOUD_ML_REGION` (only
  needed if you enable Design).

> A bare container with no env = everything enabled (the "test" environment). This `.env` is
> what turns it into your real deployment.
>
> **Design & Deploy** is `false` by default: enabling it needs `uv`/python + AWS credentials
> that aren't in the image (the Design tab would appear but its AWS deploy would fail). Set
> `DESIGN_ENABLED=true` only once the image is made Design-capable.

## Deploy on a machine

Requires Docker Engine + the Compose plugin.

```bash
# 1. Get the files (clone the repo, or scp just this folder)
git clone <repo-url> && cd <repo>/deploy/vps
#   or:  scp -r deploy/vps vps:~/aws-architect && ssh vps; cd ~/aws-architect

# 2. (optional) edit .env in place — images, DOMAIN, modes, token, GCP
#    Make sure DNS for $DOMAIN points here and ports 80/443 are open (see above).

# 3. Run (stays up across reboots; restart: unless-stopped)
docker compose up -d

# 4. Check
docker compose ps                          # backend + frontend should be "healthy"
docker compose logs -f caddy               # watch it obtain the Let's Encrypt cert
curl https://diagrammer.alejandropozo.com/health   # {"ok":true}  (once the cert is issued)
```

Open `https://diagrammer.alejandropozo.com/` for the app; the **Agent** tab connects over a
secure `wss://` WebSocket automatically.

## Auto-update

Watchtower checks Docker Hub every 30s. When CI pushes a new `:latest` (backend or frontend),
it pulls and recreates just that container — no manual step. Watch it:

```bash
docker compose logs -f watchtower
```

## Operations

```bash
docker compose pull && docker compose up -d   # manual update (Watchtower does this for you)
docker compose logs -f backend                # app logs
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
- The `VISUALIZER_TOKEN` here must match the `VISUALIZER_TOKEN` the MCP server sends.
