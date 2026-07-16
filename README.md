# Sigilum

Visual web app (hosted at [sigilum.cloud](https://sigilum.cloud)) that keeps a live
**sigil** — an architecture diagram — in sync with what your coding agent designs and
deploys in AWS. The agent (Claude Code, opencode, …) connects through the
[`sigilum-mcp`](mcp-visualizer/) MCP server and reports resource **deltas**
(`push_sigil`); the backend merges them into the authoritative state, generates the
D2 diagram with **Gemini on Google Vertex AI** (via `@google/genai`), renders it to
SVG and streams it to the web over a WebSocket.

## How it works

- **Design first.** The agent pushes resources without `deployed` → a **Design** sigil:
  the architecture is drawn but nothing exists in AWS. Iterate freely.
- **Deploy.** `deploy_sigil` marks the sigil **Live** and returns the full spec; the
  agent provisions each resource with its own AWS tools and reports the real IDs/ARNs
  back via `push_sigil` (same resource ids — nodes are enriched, not duplicated).
- **Resume.** `list_sigils` / `load_sigil` reopen an earlier sigil with its full live
  state so new changes merge onto it.

A sigil is either **Design** or **Live**, never a mix. See [EXAMPLES.md](EXAMPLES.md)
for ready-to-paste end-to-end scenarios.

The web app adds auth (email + password), per-user MCP tokens (**Connect agent**),
on-demand AI explanations of each sigil, and an admin console (usage, limits, bans).

## Run

```bash
# prerequisites: node 20+, Vertex AI credentials (below)
cd server && npm install && npm start          # backend on :3001
cd client && npm install && npm run dev        # frontend on :5173 (proxies /api + /ws-visualizer)
```

Optional env: `PORT` (default 3001), `AGENT_ENABLED=false` to disable the app,
`AUTH_DISABLED=true` for a single local "dev" user (the default in local dev).

Connect your agent: web app → **Connect agent** → generate a token, or in local dev use
`SIGILUM_TOKEN=viz_localdev SIGILUM_URL=http://localhost:3001`.

## LLM credentials (Gemini via Vertex AI — pay with GCP credits)

Used for the sigil D2 generation, session auto-naming, and explanations.

1. In your GCP project: enable the **Vertex AI API** (Gemini models are available by
   default — no Model Garden opt-in or quota request needed, unlike Claude).
2. Authenticate with Application Default Credentials (no API key):
   ```bash
   gcloud auth application-default login
   export GCP_PROJECT_ID=<your-gcp-project-id>
   # optional: export CLOUD_ML_REGION=us-central1   # default; MUST be a physical region (not "global")
   ```

The client lives in `server/agents/shared/client.js`: it builds a `GoogleGenAI`
(`vertexai: true`) instance and exposes it through a thin Anthropic-Messages-compatible
adapter. All calls use `gemini-2.5-flash` (see `MODELS` in that file).

## Repo layout

| Path | What it is |
|---|---|
| `server/` | Node/Express backend: sigil state + D2 render + auth + admin + `/ws-visualizer` |
| `client/` | React (Vite) web app: the sigil workspace (dockview), auth, admin |
| `mcp-visualizer/` | The `sigilum-mcp` MCP server (published to npm) agents connect with |
| `opencode-diagrammer-setup/` | `sigilum-opencode-setup` npm helper that writes the opencode MCP entry |
| `deploy/vps/` | Production stack: Docker Compose + Caddy (HTTPS) + Watchtower |
| `loadtest/` | Load harness for the push→render pipeline |
