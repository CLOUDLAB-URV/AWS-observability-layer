# sigilum-opencode-setup

One-shot setup that connects the **sigilum** MCP to
[opencode](https://opencode.ai). It writes the MCP entry into
`~/.config/opencode/opencode.json` for you — no hand-editing JSON.

```bash
SIGILUM_TOKEN=viz_your_token npx -y sigilum-opencode-setup
```

Get your `viz_…` token from the web app → **Sigils** → **⚙ Connect agent** →
**Generate token** (shown once). The "Connect agent" panel also shows this exact command with your
token already filled in.

## What it does (Linux)

1. **Checks your token** (from `SIGILUM_TOKEN` — legacy `VISUALIZER_TOKEN` also works — or
   `--token viz_…`).
2. **Checks opencode is installed.** If not, it asks whether to install it; on yes it runs
   `npm install -g opencode-ai`, falling back to the official installer
   (`curl -fsSL https://opencode.ai/install | bash`) if that fails. On no, it stops.
3. **Idempotently adds the MCP** under `mcp.sigilum` in
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
    "sigilum": {
      "type": "local",
      "command": ["npx", "-y", "sigilum-mcp@latest"],
      "enabled": true,
      "environment": { "SIGILUM_TOKEN": "viz_your_token" }
    }
  }
}
```

## Options & environment

- `SIGILUM_TOKEN` (env) or `--token viz_…` / `-t viz_…` — your API token (required).
  Legacy `VISUALIZER_TOKEN` is honoured as a fallback.
- `SIGILUM_URL` (env; legacy `VISUALIZER_URL`) — point the MCP at another deployment
  (e.g. `http://127.0.0.1:3001` for local dev). Only applied when the entry is first created.
- `--yes` / `-y` — auto-confirm the opencode install prompt (useful for unattended runs).
- `--uninstall` / `-u` — remove the MCP instead of adding it (see below). No token needed.

## Remove it later

```bash
npx -y sigilum-opencode-setup --uninstall
```

Idempotently checks `~/.config/opencode/opencode.json` and removes the `sigilum` entry if it's
there — running it again (or when the entry was never added) is a safe no-op. Doesn't touch
opencode itself or any other MCP entries. Equivalent to deleting the `sigilum` block from
`~/.config/opencode/opencode.json` by hand.

---

This package only configures opencode. The MCP server itself is
[`sigilum-mcp`](https://www.npmjs.com/package/sigilum-mcp),
which the entry above launches via `npx`.
