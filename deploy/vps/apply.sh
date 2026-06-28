#!/usr/bin/env bash
# Apply local config changes to the running stack.
#
# Run this on the VPS after you edit .env (and optionally Caddyfile).
# It re-applies the compose stack idempotently: docker compose recomputes each service's
# config hash (it includes the interpolated .env and the backend's `env_file: .env`), so it
# recreates ONLY the services whose config actually changed and leaves the rest running.
# No git, no network in — purely local.
#
# Scope: applies local config only (.env / Caddyfile). Image updates are Watchtower's job,
# so this does not pull images.
#
# Usage:
#   ./apply.sh            apply changes (recreates only what changed)
#   ./apply.sh --force    force-recreate all services (last resort if a change isn't detected)

set -euo pipefail

# Work from this script's own directory so compose finds compose.yaml + .env
# regardless of where it's invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

force=0
for arg in "$@"; do
    case "$arg" in
        --force) force=1 ;;
        -h|--help)
            # Print the header comment block (skip the shebang, stop at the first code line).
            awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
            exit 0 ;;
        *)
            echo "Unknown option: $arg (use --force or --help)" >&2
            exit 2 ;;
    esac
done

log() { printf '\033[1m[apply]\033[0m %s\n' "$*"; }

# Pick `docker compose` (v2) or legacy `docker-compose`.
if docker compose version >/dev/null 2>&1; then
    dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    dc() { docker-compose "$@"; }
else
    echo "Error: docker compose is not installed." >&2
    exit 1
fi

# The app config + secrets file is required by the backend (env_file in compose.yaml).
if [ ! -f .env ]; then
    echo "Error: .env is missing. Create it from the template:" >&2
    echo "    cp .env.example .env   # then fill in domain + secrets" >&2
    exit 1
fi

# Validate the merged config BEFORE touching anything running — a typo in .env or
# compose.yaml fails here without disturbing the live stack.
log "Validating configuration…"
if ! dc config -q; then
    echo "Error: invalid compose configuration (check .env / compose.yaml). Nothing changed." >&2
    exit 1
fi

# Apply. compose recreates only the services whose resolved config changed.
if [ "$force" -eq 1 ]; then
    log "Applying (forced full recreate)…"
    dc up -d --remove-orphans --force-recreate
else
    log "Applying changes (recreates only what changed)…"
    dc up -d --remove-orphans
fi

# If the Caddyfile changed, compose won't recreate caddy (it's a read-only bind mount),
# so hot-reload it — validates the new config and applies it with zero downtime. Harmless
# (no-op) when the Caddyfile is unchanged.
if dc ps --services 2>/dev/null | grep -qx caddy; then
    log "Reloading Caddy (zero-downtime)…"
    dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
        || log "Caddy reload skipped (not running, no change, or reload failed) — continuing."
fi

log "Done. Current state:"
dc ps
