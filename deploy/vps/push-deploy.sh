#!/usr/bin/env bash
# Deploy the deploy/vps folder to your VPS over SSH and apply it, transactionally.
#
# Run this on your LOCAL machine. It uploads this folder to the VPS, then runs a remote
# transaction (remote-deploy.sh) that swaps it in, runs apply.sh and health-checks. On
# success it stays deployed; on failure it rolls back — a previously working deployment is
# restored untouched, a fresh failed install is removed entirely.
#
# Config: copy .env.deploy.example → .env.deploy and set SSH_TARGET / REMOTE_DIR.
#
# Usage:
#   ./push-deploy.sh            deploy
#   ./push-deploy.sh --dry-run  show what rsync would upload, touch nothing on the VPS
#   ./push-deploy.sh --help

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this folder = deploy/vps

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help)
            awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
            exit 0 ;;
        *) echo "Unknown option: $arg (use --dry-run or --help)" >&2; exit 2 ;;
    esac
done

log() { printf '\033[1m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# --- config ---------------------------------------------------------------------------------
[ -f .env.deploy ] || die "Missing .env.deploy. Create it:  cp .env.deploy.example .env.deploy  (then set SSH_TARGET / REMOTE_DIR)"
# shellcheck disable=SC1091
set -a; . ./.env.deploy; set +a
: "${SSH_TARGET:?Set SSH_TARGET in .env.deploy}"
: "${REMOTE_DIR:?Set REMOTE_DIR in .env.deploy}"
SSH_PORT="${SSH_PORT:-22}"
case "$REMOTE_DIR" in /*) ;; *) die "REMOTE_DIR must be an absolute path (got '$REMOTE_DIR')." ;; esac

SSH_OPTS=(-p "$SSH_PORT")
SCP_OPTS=(-P "$SSH_PORT")
ssh_vps()  { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

# --- preflight ------------------------------------------------------------------------------
command -v rsync >/dev/null || die "rsync is not installed locally."
[ -f .env ] || die "Missing .env (app config + secrets). Create it from .env.example and fill it in."
[ -f compose.yaml ] || die "compose.yaml not found — run this from deploy/vps."

if [ "$DRY_RUN" -eq 0 ]; then
    log "Checking SSH connectivity to '$SSH_TARGET'…"
    ssh_vps true || die "Cannot SSH to '$SSH_TARGET'. Check .env.deploy / your ~/.ssh/config."
    log "Checking Docker on the VPS…"
    ssh_vps 'docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1' \
        || die "Docker Compose is not available on the VPS."
fi

STAGING="${REMOTE_DIR}.staging"
RSYNC_EXCLUDES=(--exclude '.env.deploy' --exclude 'push-deploy.sh' --exclude 'remote-deploy.sh' --exclude '*.bak.*' --exclude '.git')

# --- dry run --------------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN — files that would upload to $SSH_TARGET:$STAGING/ :"
    rsync -azn --delete "${RSYNC_EXCLUDES[@]}" -e "ssh ${SSH_OPTS[*]}" ./ "$SSH_TARGET:$STAGING/" || true
    log "DRY RUN — nothing was changed on the VPS."
    exit 0
fi

# --- upload + transactional apply -----------------------------------------------------------
log "Uploading deploy/vps → $SSH_TARGET:$STAGING/"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" -e "ssh ${SSH_OPTS[*]}" ./ "$SSH_TARGET:$STAGING/" \
    || die "Upload (rsync) failed."

REMOTE_SCRIPT="/tmp/aws-architect-remote-deploy.$(date +%s).sh"
log "Sending the deploy transaction to the VPS…"
scp "${SCP_OPTS[@]}" -q remote-deploy.sh "$SSH_TARGET:$REMOTE_SCRIPT" || die "Could not copy remote-deploy.sh."

log "Running the deploy on the VPS (apply + health-check, with rollback on failure)…"
set +e
ssh_vps "bash '$REMOTE_SCRIPT' '$REMOTE_DIR' '$STAGING'"
rc=$?
set -e
ssh_vps "rm -f '$REMOTE_SCRIPT'" || true

if [ "$rc" -eq 0 ]; then
    log "✓ Deploy succeeded — the stack is live and healthy on '$SSH_TARGET'."
else
    die "Deploy failed and was rolled back on the VPS (see the [remote] log above). Your VPS is unchanged."
fi
