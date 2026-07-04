# Sigilum

Visual web app (hosted at [sigilum.cloud](https://sigilum.cloud)) for designing AWS
architectures by chat, deploying them, and keeping the live **sigil** — the architecture
diagram — in sync with what is really inside AWS. Clean web rewrite of the
"Extension Logic" VS Code pipeline: the Node backend is itself the MCP client to
`awslabs.aws-api-mcp-server` and calls **Gemini on Google Vertex AI** directly (via
`@google/genai`) — no proxy, no opencode/Copilot needed. Orchestration is a LangGraph
state graph (`server/graph.js`) over per-agent modules under `server/agents/`.

## Modes

- **Preview** — chat iterates on a D2 diagram (Gemini Flash). Nothing touches AWS.
- **Deploy to AWS** — an agent (Gemini Pro) executes the diagram against AWS via the MCP
  server; every CLI answer is captured into `server/data/workflow.json` + `queue.json`;
  a state-merge prompt rebuilds the diagram from the real deployed state.
- **Deployed** — every chat prompt is executed directly in AWS, then the diagram
  re-merges automatically.

## Run

```bash
# prerequisites: node 20+, uvx (uv), AWS SSO session
aws sso login --profile apozo-cloudlab

cd server && npm install && npm start          # backend on :3001
cd client && npm install && npm run dev        # frontend on :5173 (proxies /ws)
```

Optional env: `AWS_PROFILE` (default `apozo-cloudlab`), `AWS_REGION` (default `us-east-1`),
`PORT` (default 3001), `AWS_MCP_COMMAND`/`AWS_MCP_ARGS` to override the MCP server launch.

## LLM credentials (Gemini via Vertex AI — pay with GCP credits)

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
adapter, so the agents and the shared tool-loop stay provider-agnostic.

## Model routing (cost control)

| Call | Model |
|---|---|
| Preview chat + D2 generation (architect) | `gemini-2.5-flash` |
| State-merge / reconcile (CLI answers → deployed diagram) | `gemini-2.5-flash` |
| Deploy / deployed-mode agent loop (AWS tools) | `gemini-2.5-pro` |
