# diagram-state-visualizer-mcp

A **self-contained** MCP server for the **AWS Architect Web** "Deployed state" view.
It renders a live diagram of what is actually deployed in AWS — **no AWS MCP server
required**.

The server does **not** run AWS commands. Your agent deploys with its own tools and
then **reports what changed**: after each deploy or modification it calls
`push_deployment` with just the **delta** — the resources it created or modified
(`upsert`) and the ones it removed (`delete`). The backend keeps the full,
authoritative state by merging those changes and regenerates the diagram.

The backend and web URLs are **baked into the server** (`BACKEND_URL` / `WEB_URL`
constants at the top of `index.js`) because it targets one specific web app. The
**only** thing you configure is your API token, via the `VISUALIZER_TOKEN`
environment variable.

**One diagram per chat.** Each MCP process gets its own chat id at startup, so every
chat session keeps an isolated diagram — you don't manage project names. To resume a
previous deployment (so the agent knows what already exists), use the `load_chat` /
`list_chats` tools, or pin a fixed chat with the optional `VISUALIZER_CHAT_ID` env var.

---

## 1. Prerequisites

- **Node.js 20+** (so `npx` can run this server).
- A way for your agent to **deploy to AWS** (its own AWS tooling / CLI / MCP). This
  server does not deploy — it only receives the resulting changes.
- The **AWS Architect Web app running** (backend on `:3001`, web on `:5173`).

> You do **not** need `awslabs.aws-api-mcp-server` for this server itself, and you
> do **not** need to clone this repo — `npx` downloads and runs the server.

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
        "VISUALIZER_TOKEN": "viz_your_token_here"
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
        "VISUALIZER_TOKEN": "viz_your_token_here"
      },
      "enabled": true
    }
  }
}
```

> To pin a specific version, replace `@latest` with `@1.2.3`.

## 4. Use it

1. Make sure the web app is running and your agent can reach AWS.
2. In your agent, ask it to deploy something, e.g.
   *"Create an S3 bucket and an SQS queue under project `my-api`, and visualize it."*
3. The agent deploys with its own tools and then calls **`push_deployment`** with the
   resources it created (`op: "upsert"`). The diagram for the current chat appears.
4. Open the web app → **Deployed state** → pick the chat from the selector → see the
   live diagram. It updates automatically after each push.
5. Ask for a change — e.g. *"remove one of the EC2s"* — and the agent calls
   `push_deployment` again with just that delta (`op: "delete"`); the diagram updates
   in place, keeping the same layout.
6. To continue earlier work in a new session, ask the agent to **`list_chats`** then
   **`load_chat`** with the id — it loads the current live resources (IDs/ARNs) as
   context and new changes merge onto them.

The agent only ever reports the **delta**; the backend maintains the full state and
the diagram, so the agent never has to resend the whole stack.

---

## Tools

### `push_deployment({ project, changes })` — the push tool

Report what changed in AWS after a deploy or modification. `changes` is the **delta**,
one entry per resource that changed:

```jsonc
{
  "op": "upsert",            // "upsert" = created/modified, "delete" = removed
  "type": "ec2",            // AWS service type
  "id": "i-0abc",           // stable key (InstanceId / ARN / bucket name)
  "state": "running",
  "vpc": "vpc-9", "subnet": "subnet-1",
  "connections": [{ "to": "db-1", "protocol": "TCP", "port": 5432 }],
  "details": { /* full describe output, kept verbatim in the backend */ }
}
```

- Send **only what changed**, not the whole deployment. `op: "delete"` needs just
  `type` + `id`.
- Always include the **relationships** (`connections`, `vpc`, `subnet`) — the diagram
  draws those edges and containment.
- The backend merges each change onto the chat's state (upsert sets the resource,
  delete removes it) and regenerates the diagram, evolving the previous one.

### `list_chats()` — discover previous chats

Lists your deployment chats (newest first) with their id, label, and last-updated
time, so you can pick one to resume.

### `load_chat({ chat })` — resume a previous deployment

Switches this session to an existing chat and returns its **current live resources**
(real IDs/ARNs, state, relationships). After loading, `push_deployment` merges onto
that chat's state.

> `push_deployment` also accepts an optional `chat` argument to target an explicit
> chat for a single call.

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
