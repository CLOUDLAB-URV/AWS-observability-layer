# diagram-state-visualizer-mcp

A **self-contained** MCP server for the **AWS Architect Web** "Deployed state" view.
It runs AWS CLI commands for you (directly, via the local terminal) and renders a
live diagram of what is actually deployed in AWS — **no AWS MCP server required**.

You give it `aws …` CLI commands; it executes each with your local AWS CLI, captures
the results, and uploads the batch to the backend, which generates the diagram.

The backend and web URLs are **baked into the server** (`BACKEND_URL` / `WEB_URL`
constants at the top of `index.js`) because it targets one specific web app. The
**only** thing you configure is your API token, via the `VISUALIZER_TOKEN`
environment variable (optionally `AWS_REGION` / `AWS_PROFILE` for the CLI).

---

## 1. Prerequisites

- **Node.js 20+** (so `npx` can run this server).
- **AWS CLI v2** installed and on your `PATH` (`aws --version`).
- **AWS credentials** available to your shell (e.g. `aws sso login --profile <profile>`).
- The **AWS Architect Web app running** (backend on `:3001`, web on `:5173`).

> You do **not** need `awslabs.aws-api-mcp-server` or any other AWS MCP server, and
> you do **not** need to clone this repo — `npx` downloads and runs the server.

## 2. Get your API token

Open the web app → **Deployed state** tab → **⚙ Connect agent** → **Generate token**.
Copy the `viz_…` value (shown once). This is your `VISUALIZER_TOKEN`.

## 3. Configure your agent (via npx)

Register **only this one** MCP server. `npx -y diagram-state-visualizer-mcp@latest`
always runs the latest published version — no install step, auto-updates.

### Claude Code

**Fastest — CLI.** `-s user` = global (all projects); `-s project` = just this repo;
omit `-s` = local/private.

```bash
claude mcp add diagram-state-visualizer -s user \
  -e VISUALIZER_TOKEN=viz_your_token_here \
  -e AWS_REGION=us-east-1 -e AWS_PROFILE=apozo-cloudlab \
  -- npx -y diagram-state-visualizer-mcp@latest
```

Verify with `claude mcp list`.

**Manual — JSON.** Global: `~/.claude.json`. Project: `.mcp.json` in the repo root.

```json
{
  "mcpServers": {
    "diagram-state-visualizer": {
      "command": "npx",
      "args": ["-y", "diagram-state-visualizer-mcp@latest"],
      "env": {
        "VISUALIZER_TOKEN": "viz_your_token_here",
        "AWS_REGION": "us-east-1",
        "AWS_PROFILE": "apozo-cloudlab"
      }
    }
  }
}
```

### opencode

Global: `~/.config/opencode/opencode.json`. Project: `opencode.json` in the repo root.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "diagram-state-visualizer": {
      "type": "local",
      "command": ["npx", "-y", "diagram-state-visualizer-mcp@latest"],
      "environment": {
        "VISUALIZER_TOKEN": "viz_your_token_here",
        "AWS_REGION": "us-east-1",
        "AWS_PROFILE": "apozo-cloudlab"
      },
      "enabled": true
    }
  }
}
```

> To pin a specific version, replace `@latest` with `@1.2.3`.

## 4. Use it

1. Make sure the web app is running and your AWS session is valid
   (`aws sso login --profile <profile>`).
2. In your agent, ask it to deploy something, e.g.
   *"Create an S3 bucket and an SQS queue under project `my-api`, and visualize it."*
3. The agent calls **`deploy_and_visualize`** with the `aws` commands; this server
   runs them and pushes the result.
4. Open the web app → **Deployed state** → type the project name → see the live
   diagram. It updates automatically after each call.

The agent receives the real command outputs (IDs/ARNs) back, so it can chain
follow-up commands (e.g. use a VPC id from `create-vpc` in the next call).

---

## Tools

### `deploy_and_visualize({ project, commands })` — primary

Runs each `aws` CLI command in order with the local AWS CLI, then uploads the batch
and renders the diagram. `commands` is a list of full `aws …` strings. For safety,
each must be a **single** `aws` command — no pipes, redirects, chaining, or
substitutions (`| & ; \` $() <> ` and newlines are rejected). Output is forced to
JSON unless you pass `--output`. Returns per-command results plus the diagram link.

### `push_deployment({ project, operations })` — for already-run deployments

Use when you ran the `aws` commands yourself and just want to visualize them.
`operations` is one entry per command: `{ action, resource_state?, error? }`.

---

## Local development

To run from a clone instead of npx (for hacking on the server):

```bash
cd mcp-visualizer
npm install
# point your agent's MCP "command"/"args" at: node /absolute/path/to/mcp-visualizer/index.js
```

## Publishing & updating (maintainer)

Published to npm as [`diagram-state-visualizer-mcp`](https://www.npmjs.com/package/diagram-state-visualizer-mcp).

**One-time setup**

```bash
npm login
```

**First publish** (run from `mcp-visualizer/`):

```bash
npm publish        # public, unscoped → publishes directly
```

**Release an update**

1. Make your change (e.g. edit `BACKEND_URL` / `WEB_URL` when migrating domains).
2. Bump the version + create a git commit and tag:
   ```bash
   npm version patch     # or: minor | major
   ```
3. Publish:
   ```bash
   npm publish
   ```
4. Push the version commit and tag:
   ```bash
   git push --follow-tags
   ```

Users on `@latest` get the new version automatically the next time their agent
starts the server (npx resolves `@latest` to the newest published version). Anyone
pinned to `@x.y.z` stays on that version until they bump the pin.

The `prepublishOnly` script runs `node --check index.js` before each publish as a
sanity gate.
