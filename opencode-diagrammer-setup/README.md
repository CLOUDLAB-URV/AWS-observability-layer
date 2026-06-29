# @apozo/opencode-diagrammer-setup

One-shot setup that connects the **diagram-state-visualizer** MCP to
[opencode](https://opencode.ai). It writes the MCP entry into
`~/.config/opencode/opencode.json` for you — no hand-editing JSON.

```bash
VISUALIZER_TOKEN=viz_your_token npx -y @apozo/opencode-diagrammer-setup
```

Get your `viz_…` token from the web app → **Deployed state** → **⚙ Connect agent** →
**Generate token** (shown once). The "Connect agent" panel also shows this exact command with your
token already filled in.

## What it does (Linux)

1. **Checks your token** (from `VISUALIZER_TOKEN`, or `--token viz_…`).
2. **Checks opencode is installed.** If not, it asks whether to install it; on yes it runs
   `npm install -g opencode-ai`, falling back to the official installer
   (`curl -fsSL https://opencode.ai/install | bash`) if that fails. On no, it stops.
3. **Idempotently adds the MCP** under `mcp.diagram-state-visualizer` in
   `~/.config/opencode/opencode.json`:
   - creates the file / the `mcp` object / the entry when missing;
   - if the entry already exists, **only the token is refreshed** — your `command`, `enabled` flag
     and any other fields stay exactly as they are.

The token is never printed. An existing `opencode.json` that isn't valid JSON is left untouched
(the tool refuses to overwrite it).

The entry it writes:

```json
{
  "mcp": {
    "diagram-state-visualizer": {
      "type": "local",
      "command": ["npx", "-y", "diagram-state-visualizer-mcp@latest"],
      "enabled": true,
      "environment": { "VISUALIZER_TOKEN": "viz_your_token" }
    }
  }
}
```

## Options & environment

- `VISUALIZER_TOKEN` (env) or `--token viz_…` / `-t viz_…` — your API token (required).
- `VISUALIZER_URL` (env) — point the MCP at another deployment (e.g. `http://127.0.0.1:3001` for
  local dev). Only applied when the entry is first created.
- `--yes` / `-y` — auto-confirm the opencode install prompt (useful for unattended runs).

## Remove it later

Delete the `diagram-state-visualizer` block from `~/.config/opencode/opencode.json`.

---

This package only configures opencode. The MCP server itself is
[`diagram-state-visualizer-mcp`](https://www.npmjs.com/package/diagram-state-visualizer-mcp),
which the entry above launches via `npx`.
