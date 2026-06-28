#!/usr/bin/env bash
# Transactional deploy, runs ON the VPS (uploaded to /tmp and invoked by push-deploy.sh).
#
#   remote-deploy.sh <REMOTE_DIR> <STAGING_DIR>
#
# STAGING_DIR already holds the freshly uploaded deploy/vps folder. This script swaps it into
# REMOTE_DIR, runs apply.sh, and health-checks. On success it keeps the new deploy; on ANY
# failure it rolls back:
#   - if a deployment already existed, the previous folder is restored and (if it was running)
#     brought back up — nothing is deleted, volumes/certs stay intact;
#   - if this was a fresh install, the failed stack + its volumes + the folder are removed, so
#     the VPS is left exactly as it was before (clean).
#
# Persistence lives in NAMED volumes (app_data/caddy_data/caddy_config), and the compose project
# name = basename(REMOTE_DIR). Keeping REMOTE_DIR's name stable means up/down always target the
# same stack & volumes; rollback restores the original folder name before bringing the stack up.

set -euo pipefail

REMOTE_DIR="${1:?usage: remote-deploy.sh <REMOTE_DIR> <STAGING_DIR>}"
STAGING="${2:?usage: remote-deploy.sh <REMOTE_DIR> <STAGING_DIR>}"
BACKUP="${REMOTE_DIR}.bak.$(date +%Y%m%d%H%M%S)"
HEALTH_TIMEOUT=90

log()  { printf '\033[1m[remote]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[remote]\033[0m %s\n' "$*" >&2; }

# docker compose v2 or legacy docker-compose.
if docker compose version >/dev/null 2>&1; then
    dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
    dc() { docker-compose "$@"; }
else
    err "docker compose is not installed on the VPS."
    exit 1
fi

# --- state of the existing deployment (decides rollback behavior) ----------------------------
HAD_DIR=0
WAS_RUNNING=0
BACKED_UP=0
SWAPPED=0
if [ -d "$REMOTE_DIR" ]; then
    HAD_DIR=1
    if [ -n "$(cd "$REMOTE_DIR" && dc ps -q 2>/dev/null || true)" ]; then
        WAS_RUNNING=1
    fi
fi

rollback() {
    err "Deployment failed — rolling back."
    # Stop whatever the failed attempt left running in REMOTE_DIR.
    if [ "$SWAPPED" -eq 1 ] && [ -d "$REMOTE_DIR" ]; then
        (cd "$REMOTE_DIR" && dc down --remove-orphans) || true
    fi
    if [ "$HAD_DIR" -eq 1 ]; then
        # Restore the previous folder under its ORIGINAL name (same project & volumes).
        if [ "$BACKED_UP" -eq 1 ]; then
            rm -rf "$REMOTE_DIR"
            mv "$BACKUP" "$REMOTE_DIR"
        fi
        if [ "$WAS_RUNNING" -eq 1 ]; then
            log "Restoring the previous deployment…"
            (cd "$REMOTE_DIR" && dc up -d) || err "Could not bring the previous stack back up — check it manually."
        fi
        err "↩ Rolled back: previous deployment restored. Nothing was deleted."
    else
        # Fresh install that failed: remove the stack, its (empty) volumes, and the folder.
        if [ -d "$REMOTE_DIR" ]; then
            (cd "$REMOTE_DIR" && dc down -v --remove-orphans) || true
            rm -rf "$REMOTE_DIR"
        fi
        err "↩ Rolled back: failed deploy removed, VPS left as it was (clean)."
    fi
    rm -rf "$STAGING" 2>/dev/null || true
    exit 1
}

# Wait until a compose service's container reports healthy (or fail on timeout/unhealthy).
wait_healthy() {
    local svc="$1" deadline=$((SECONDS + HEALTH_TIMEOUT)) cid status
    while [ "$SECONDS" -lt "$deadline" ]; do
        cid="$(cd "$REMOTE_DIR" && dc ps -q "$svc" 2>/dev/null || true)"
        if [ -n "$cid" ]; then
            status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo missing)"
            case "$status" in
                healthy) return 0 ;;
                unhealthy) err "Service '$svc' is unhealthy."; return 1 ;;
            esac
        fi
        sleep 3
    done
    err "Service '$svc' did not become healthy within ${HEALTH_TIMEOUT}s."
    return 1
}

[ -d "$STAGING" ] || { err "Staging dir $STAGING not found (upload failed?)."; exit 1; }

# --- transaction ----------------------------------------------------------------------------
if [ "$HAD_DIR" -eq 1 ]; then
    log "Backing up the current deployment → $BACKUP"
    # Nothing has changed yet, so a failure here is a safe abort (no rollback needed).
    mv "$REMOTE_DIR" "$BACKUP" || { err "Could not back up $REMOTE_DIR — aborting, nothing changed."; exit 1; }
    BACKED_UP=1
fi

log "Installing the new deployment → $REMOTE_DIR"
mv "$STAGING" "$REMOTE_DIR" || rollback
SWAPPED=1

log "Applying (apply.sh)…"
( cd "$REMOTE_DIR" && chmod +x apply.sh && ./apply.sh ) || rollback

log "Health-checking backend + frontend (≤${HEALTH_TIMEOUT}s)…"
wait_healthy backend  || rollback
wait_healthy frontend || rollback

# --- success --------------------------------------------------------------------------------
if [ "$BACKED_UP" -eq 1 ]; then
    rm -rf "$BACKUP"
fi
log "✓ Deployed and healthy."
( cd "$REMOTE_DIR" && dc ps )
