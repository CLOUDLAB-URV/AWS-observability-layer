#!/usr/bin/env bash
# One-shot setup for a lab demo: installs opencode (if missing) and configures it to talk to
# Gemini through Vertex AI, authenticated with a Vertex AI "Express mode" API key. Does NOT touch
# MCP at all — this is not sigilum-opencode-setup, it's just "get opencode + Gemini working" for
# people trying out the app.
#
# Only downloadable from inside the logged-in app (Sigils → Connect agent) — not a public URL.
#
# What it does (Linux):
#   1. Checks whether `opencode` is on PATH; if not, installs it with the official installer
#      (curl -fsSL https://opencode.ai/install | bash) — a self-contained binary in
#      ~/.opencode/bin, no Node/npm needed. Installs curl and python3 via apt if missing
#      (python3 is needed for the config step). Everything works in ONE run on a bare Debian —
#      no "open a new terminal and re-run".
#   2. Idempotently writes provider.google-vertex.options.apiKey into
#      ~/.config/opencode/opencode.json (Vertex AI Express mode — no project/location/service
#      account needed), and sets a default model if none is set yet. Re-running only refreshes the
#      key; everything else in the file is left exactly as it is.
#
# Pass --uninstall (or -u) to remove the google-vertex block this script adds (no key needed).
#
# WARNING: the key below is embedded in this file (and therefore public once this is hosted /
# committed) and also ends up in plain text in opencode.json on every machine that runs this — it
# must be a short-lived, throwaway key that gets revoked in the GCP console right after the demo.

set -euo pipefail

# ---- fill this in before publishing, then revoke it in the GCP console once the demo is over ----
API_KEY="AQ.Ab8RN6LKkkzYvbMMClGfbNm8ounScHsgyH4ztrgMRAuNDsXpgQ"
# ----------------------------------------------------------------------------------------------

CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
DEFAULT_MODEL="google-vertex/gemini-2.5-flash"

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

UNINSTALL=0

while [ $# -gt 0 ]; do
    case "$1" in
        --key)
            API_KEY="${2:-}"
            shift 2
            ;;
        --key=*)
            API_KEY="${1#--key=}"
            shift
            ;;
        --uninstall|-u)
            UNINSTALL=1
            shift
            ;;
        *)
            err "✖ Unknown argument: $1"
            exit 1
            ;;
    esac
done

is_opencode_installed() {
    command -v opencode >/dev/null 2>&1
}

# Run a command as root: directly when we already are root, via sudo otherwise. Returns 1
# (instead of exploding) when neither applies, so callers can fall back.
as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        return 1
    fi
}

# Official installer only — it drops a self-contained binary in ~/.opencode/bin, so no Node/npm
# is needed at all (the npm route breaks on Debian: apt's npm can't write /usr/local as a user).
install_opencode() {
    if ! command -v curl >/dev/null 2>&1; then
        log "curl not found — installing via apt…"
        if ! (as_root apt-get update && as_root apt-get install -y curl); then
            err "✖ curl is required to install opencode and couldn't be installed."
            exit 1
        fi
    fi

    log "Installing opencode via the official installer…"
    curl -fsSL https://opencode.ai/install | bash

    # The installer only adds ~/.opencode/bin to PATH for FUTURE shells (via .bashrc) — export
    # it for THIS process too, so the config step below still runs in the same invocation
    # instead of bailing with "open a new terminal".
    export PATH="$HOME/.opencode/bin:$PATH"
    hash -r
}

# apply_config/uninstall_config are written in python3; a bare Debian may not have it.
ensure_python3() {
    if command -v python3 >/dev/null 2>&1; then
        return 0
    fi
    log "python3 not found — installing via apt…"
    if command -v apt-get >/dev/null 2>&1 && as_root apt-get update && as_root apt-get install -y python3; then
        return 0
    fi
    err "✖ python3 is required to write the opencode config and couldn't be installed."
    exit 1
}

# --uninstall path: idempotently remove the google-vertex block this script adds.
uninstall_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        log "Nothing to remove — $CONFIG_FILE doesn't exist."
        return 0
    fi

    python3 - "$CONFIG_FILE" "$DEFAULT_MODEL" <<'PYEOF'
import json
import sys

config_file, default_model = sys.argv[1], sys.argv[2]

with open(config_file, 'r', encoding='utf-8') as f:
    raw = f.read()

if not raw.strip():
    sys.exit(0)

try:
    config = json.loads(raw)
except json.JSONDecodeError as e:
    print(f"✖ {config_file} exists but couldn't be parsed ({e}).", file=sys.stderr)
    print("  Fix or remove that file by hand — refusing to touch it.", file=sys.stderr)
    sys.exit(1)

if not isinstance(config, dict):
    print(f"✖ {config_file} is not a JSON object — refusing to touch it.", file=sys.stderr)
    sys.exit(1)

removed = False
provider = config.get('provider')
if isinstance(provider, dict) and 'google-vertex' in provider:
    del provider['google-vertex']
    removed = True
    if not provider:
        del config['provider']

if config.get('model') == default_model:
    del config['model']
    removed = True

if not removed:
    print('NOOP')
    sys.exit(0)

tmp = config_file + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(json.dumps(config, indent=2) + '\n')
import os
os.replace(tmp, config_file)
print('REMOVED')
PYEOF
}

# Idempotently write provider.google-vertex.options.apiKey (+ default model if unset).
apply_config() {
    mkdir -p "$CONFIG_DIR"

    python3 - "$CONFIG_FILE" "$API_KEY" "$DEFAULT_MODEL" <<'PYEOF'
import json
import os
import sys

config_file, api_key, default_model = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(config_file, 'r', encoding='utf-8') as f:
        raw = f.read()
except FileNotFoundError:
    raw = ''

if not raw.strip():
    config = {}
    was_empty = True
else:
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"✖ {config_file} exists but couldn't be parsed ({e}).", file=sys.stderr)
        print("  Fix or remove that file by hand, then run this again — refusing to overwrite it.", file=sys.stderr)
        sys.exit(1)
    if not isinstance(config, dict):
        print(f"✖ {config_file} is not a JSON object — refusing to overwrite it.", file=sys.stderr)
        sys.exit(1)
    was_empty = False

if was_empty and '$schema' not in config:
    config['$schema'] = 'https://opencode.ai/config.json'

provider = config.get('provider')
if not isinstance(provider, dict):
    provider = {}
    config['provider'] = provider

entry = provider.get('google-vertex')
if not isinstance(entry, dict):
    entry = {}
    provider['google-vertex'] = entry

options = entry.get('options')
if not isinstance(options, dict):
    options = {}
    entry['options'] = options

options['apiKey'] = api_key

if 'model' not in config:
    config['model'] = default_model

tmp = config_file + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(json.dumps(config, indent=2) + '\n')
os.replace(tmp, config_file)
PYEOF
}

if [ "$UNINSTALL" -eq 1 ]; then
    ensure_python3
    result="$(uninstall_config)"
    if [ "$result" = "REMOVED" ]; then
        log "✓ Removed the google-vertex config from opencode ($CONFIG_FILE)."
    else
        log "Nothing to remove — google-vertex isn't configured in opencode ($CONFIG_FILE)."
    fi
    exit 0
fi

if [ -z "$API_KEY" ] || [ "$API_KEY" = "PUT_YOUR_VERTEX_AI_EXPRESS_MODE_API_KEY_HERE" ]; then
    err "✖ No API key set — fill in API_KEY at the top of this script (or pass --key …)."
    exit 1
fi

if ! is_opencode_installed; then
    install_opencode
    if ! is_opencode_installed; then
        err "✖ opencode still isn't on your PATH. Open a new terminal (so PATH refreshes) and run this again."
        exit 1
    fi
    log "✓ opencode installed."
fi

ensure_python3
apply_config

log ""
log "✓ opencode is ready, using Gemini via Vertex AI."
log "  Run 'opencode' and ask it to take a look at the site."
