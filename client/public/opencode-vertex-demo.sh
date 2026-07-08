#!/usr/bin/env bash
# One-shot setup for a lab demo: installs opencode (if missing) and configures it to talk to
# Gemini through Vertex AI, authenticated with a Vertex AI "Express mode" API key. Does NOT touch
# MCP at all — this is not sigilum-opencode-setup, it's just "get opencode + Gemini working" for
# people trying out the app.
#
#   bash <(curl -fsSL https://sigilum.cloud/opencode-vertex-demo.sh)
#
# What it does (Linux):
#   1. Checks whether `opencode` is on PATH; if not, installs it — `npm install -g opencode-ai`
#      (installing Node/npm via apt first if npm itself is missing), falling back to the official
#      installer (curl -fsSL https://opencode.ai/install | bash) if npm fails for any reason.
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
API_KEY="AQ.Ab8RN6LLhy4yGCEYDbh5NSGdwWUtVcgF24riLaDrp6cNkOQ0Fw"
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

# npm install -g first (installing npm itself via apt if it's missing), curl installer as fallback.
install_opencode() {
    if ! command -v npm >/dev/null 2>&1; then
        log "npm not found — installing Node.js/npm via apt…"
        if command -v apt-get >/dev/null 2>&1; then
            if ! (sudo apt-get update && sudo apt-get install -y nodejs npm); then
                err "apt install of nodejs/npm failed — falling back to the official opencode installer."
            fi
        else
            err "apt-get not available — falling back to the official opencode installer."
        fi
    fi

    if command -v npm >/dev/null 2>&1; then
        log "Installing opencode via npm (npm install -g opencode-ai)…"
        if npm install -g opencode-ai; then
            return 0
        fi
        err "npm install failed — trying the official installer…"
    fi

    curl -fsSL https://opencode.ai/install | bash
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

apply_config

log ""
log "✓ opencode is ready, using Gemini via Vertex AI."
log "  Run 'opencode' and ask it to take a look at the site."
