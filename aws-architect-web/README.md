# AWS Architect Web

Visual web app for designing AWS architectures by chat, deploying them, and keeping the
diagram in sync with what is really inside AWS. Clean web rewrite of the
"Extension Logic" VS Code pipeline: the Node backend is itself the MCP client to
`awslabs.aws-api-mcp-server` and calls the Anthropic API directly — no proxy, no
opencode/Copilot needed.

## Modes

- **Preview** — chat iterates on a D2 diagram (Haiku). Nothing touches AWS.
- **Deploy to AWS** — an agent (Sonnet) executes the diagram against AWS via the MCP
  server; every CLI answer is captured into `server/data/workflow.json` + `queue.json`;
  a state-merge prompt rebuilds the diagram from the real deployed state.
- **Deployed** — every chat prompt is executed directly in AWS, then the diagram
  re-merges automatically.

## Run

```bash
# prerequisites: node 20+, uvx (uv), AWS SSO session
aws sso login --profile cloudlab
export ANTHROPIC_API_KEY=sk-ant-...

cd server && npm install && npm start          # backend on :3001
cd client && npm install && npm run dev        # frontend on :5173 (proxies /ws)
```

Optional env: `AWS_PROFILE` (default `cloudlab`), `AWS_REGION` (default `us-east-1`),
`PORT` (default 3001), `AWS_MCP_COMMAND`/`AWS_MCP_ARGS` to override the MCP server launch.

## Model routing (cost control)

| Call | Model |
|---|---|
| Preview chat + D2 generation | `claude-haiku-4-5` |
| State-merge (CLI answers → deployed diagram) | `claude-haiku-4-5` |
| Deploy / deployed-mode agent loop (AWS tools) | `claude-sonnet-4-6` |
