#!/usr/bin/env node
'use strict';

// Distributable MCP server for Sigilum. It is self-contained and does NOT run any
// AWS commands itself: the agent deploys with its own tools, then REPORTS what
// changed. After each deploy or modification, the agent calls push_sigil with only
// the DELTA — the resources it created/changed (upsert) or removed (delete). The
// Sigilum backend keeps the authoritative, detailed state by applying those
// changes, and renders a live architecture sigil of what is actually deployed.
//
// Tools:
//   - push_sigil   : report the delta of changes (the only push tool).
//   - deploy_sigil : mark a design sigil Live and get the spec to actually build.
//   - list_sigils  : discover previous sigils (id + name).
//   - load_sigil   : resume a previous sigil BY NAME (resolved by proximity)
//                    and load its full current deployed state into context.
//
// This server targets the hosted web app by default; the only thing most users configure
// is their API token (SIGILUM_TOKEN). Point it elsewhere (e.g. a local dev backend) with
// SIGILUM_URL. The legacy VISUALIZER_* env names still work as fallbacks.
//
//   SIGILUM_TOKEN    (env, required)  API token generated in the web UI
//   SIGILUM_URL      (env, optional)  base URL of the deployment; defaults to the hosted app.
//                                     For local dev: http://127.0.0.1:3001
//   SIGILUM_SIGIL_ID (env, optional)  pin a fixed sigil (chat) id for this session

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { matchByName } from './match.js';

// --- Service endpoints --------------------------------------------------------
// Default to the hosted deployment; override both with SIGILUM_URL (e.g. for local dev).
// Legacy VISUALIZER_* names are honoured as fallbacks so existing installs keep working.
const BASE_URL = process.env.SIGILUM_URL || process.env.VISUALIZER_URL || 'https://sigilum.cloud';
const BACKEND_URL = BASE_URL;
const WEB_URL = BASE_URL;
// ------------------------------------------------------------------------------

const TOKEN = process.env.SIGILUM_TOKEN || process.env.VISUALIZER_TOKEN || '';

// Each chat gets its own isolated sigil, keyed by (user, chatId). One MCP process
// ≈ one chat, so we mint a chat id at startup (override with SIGILUM_SIGIL_ID).
// It is `let` so load_sigil can switch the active sigil to resume a previous one.
let activeChatId = process.env.SIGILUM_SIGIL_ID || process.env.VISUALIZER_CHAT_ID || randomUUID();

// Upload a batch of incremental changes for a chat to the visualizer backend
// ({ ok, text, data }). `nameHint` is an optional name hint for a brand-new session
// (the backend otherwise auto-names it); `chatId` is the storage key.
async function pushChanges(nameHint, changes, chatId, deployed) {
    if (!TOKEN) {
        return { ok: false, text: 'SIGILUM_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' };
    }
    let response;
    try {
        response = await fetch(`${BACKEND_URL}/api/chats/${encodeURIComponent(chatId)}/deployments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
            // `project` is the backend's name-hint field (kept for wire-compat).
            body: JSON.stringify({ project: nameHint, changes, ...(typeof deployed === 'boolean' ? { deployed } : {}) })
        });
    } catch (error) {
        return { ok: false, text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` };
    }
    const text = await response.text();
    if (!response.ok) {
        return { ok: false, text: `Visualizer rejected the upload (HTTP ${response.status}): ${text}` };
    }
    let data = {};
    try {
        data = JSON.parse(text);
    } catch {
        // Non-JSON body — leave data empty; callers fall back to text.
    }
    return { ok: true, text, data };
}

const server = new McpServer({ name: 'sigilum', version: '1.0.0' });

// matchByName (name → chat by proximity) lives in ./match.js so it is unit-testable
// without booting this server's transport.

// One connection between two resources, drawn as an edge in the diagram.
const connectionSchema = z
    .object({
        to: z.string().describe('The id of the OTHER resource this one connects to (must match another resource\'s id).'),
        protocol: z.string().optional().describe('Protocol, e.g. "TCP", "HTTPS", "Event".'),
        port: z.union([z.number(), z.string()]).optional().describe('Port, e.g. 5432.'),
        kind: z.string().optional().describe('Optional hint: "db" | "http" | "ssh" | "async" — colors the edge.')
    })
    .passthrough();

// One incremental change to a single resource.
const changeSchema = z
    .object({
        op: z.enum(['upsert', 'delete']).describe('"upsert" = created or modified (send full detail); "delete" = removed (type + id are enough).'),
        type: z.string().describe('AWS service type, e.g. "ec2", "rds", "s3", "lambda", "vpc".'),
        id: z.string().describe('Stable identifier of the resource (InstanceId / ARN / bucket name). This is the key the backend stores it under.'),
        name: z.string().optional().describe('Friendly name, if any.'),
        arn: z.string().optional().describe('Full AWS ARN of the resource (arn:aws:…). Always include it on Live sigils once the resource really exists in AWS — the web links it to the AWS console.'),
        region: z.string().optional().describe('AWS region, e.g. "us-east-1".'),
        state: z.string().optional().describe('Lifecycle state, e.g. "running", "available".'),
        vpc: z.string().optional().describe('VPC id this resource lives in (for containment in the diagram).'),
        subnet: z.string().optional().describe('Subnet id this resource lives in.'),
        connections: z.array(connectionSchema).optional().describe('Relationships to OTHER resources (who it talks to, protocol, port). Always include these so the diagram draws the edges.'),
        details: z.record(z.any()).optional().describe('Full describe/create output for this resource (kept verbatim in the backend state JSON).'),
        source_command: z.string().optional().describe('Optional: the aws CLI command that produced this change (audit only).')
    })
    .passthrough();

server.registerTool(
    'push_sigil',
    {
        title: 'Add resources to the architecture sigil (design or live)',
        description:
            'Add/modify resources on the architecture sigil (the live diagram), sending ONLY the ' +
            'DELTA — the resources that are new or changed, not the whole stack. Use `op:"upsert"` for ' +
            'resources to create or modify (include all their detail), and `op:"delete"` (just ' +
            '`type` + `id`) for removed ones. ALWAYS include the relationships in `connections` ' +
            '(which resource each one talks to, with protocol and port) and containment in ' +
            '`vpc`/`subnet`, because the sigil draws those edges. The backend keeps the full ' +
            'authoritative state by merging your changes.\n\n' +
            'A sigil is EITHER "Design" (a sketch — NOTHING is created in AWS) OR "Live" ' +
            '(the resources really exist in AWS). It is never a mix of both. Control this with ' +
            '`deployed`:\n' +
            '  • Omit it (default) → a brand-new sigil is a DESIGN. Use this to draft an ' +
            'architecture the user can review in the web before anything is deployed. When the ' +
            'user is happy, call `deploy_sigil` to actually deploy it.\n' +
            '  • `deployed:true` → you ACTUALLY created these in AWS already (direct deploy, no ' +
            'design step). The sigil is Live from the start.\n' +
            'On an existing sigil, `deployed` must match its current mode (the backend rejects a ' +
            'mismatch) — you cannot add design-only resources to a Live sigil or vice-versa. ' +
            'After `deploy_sigil`, a sigil is Live, so keep the SAME resource ids and upsert ' +
            'them with the real ARNs/ids and `state`.\n\n' +
            'The session is auto-named from the architecture (the user can rename it). By default ' +
            'changes go to THIS session\'s sigil; if you called load_sigil, they merge onto that one.',
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe('Optional name hint for a brand-new session. Leave unset — the backend auto-names it from the architecture.'),
            changes: z.array(changeSchema).describe('The resources that changed in this step (upsert/delete each).'),
            deployed: z
                .boolean()
                .optional()
                .describe('Sigil mode. Omit for a DESIGN sketch (nothing created in AWS — the default for a new sigil). Set true only if you ACTUALLY created these resources in AWS. Must match the sigil\'s existing mode.'),
            chat: z
                .string()
                .optional()
                .describe('Optional: target an explicit sigil id (e.g. one from load_sigil). Defaults to this session\'s sigil — leave unset for normal use.')
        }
    },
    async ({ project, changes, chat, deployed }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'SIGILUM_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        if (!Array.isArray(changes) || changes.length === 0) {
            return { isError: true, content: [{ type: 'text', text: 'No changes to report.' }] };
        }

        const chatId = chat || activeChatId;
        const result = await pushChanges(project, changes, chatId, deployed);
        if (!result.ok) {
            return { isError: true, content: [{ type: 'text', text: result.text }] };
        }

        // The backend returns the session name (auto-assigned for a new session).
        const name = result.data?.name || project || '(unnamed)';
        const mode = result.data?.deployed ? 'LIVE (deployed to AWS)' : 'DESIGN (not deployed — a sketch)';
        const upserts = changes.filter((c) => c.op !== 'delete').length;
        const deletes = changes.length - upserts;
        const lines = changes.map((c) =>
            c.op === 'delete' ? `− delete ${c.type} ${c.id}` : `+ upsert ${c.type} ${c.id}`
        );
        const nextHint = result.data?.deployed
            ? ''
            : '\n\nThis sigil is a DESIGN — nothing is created in AWS yet. When the user approves it, call deploy_sigil to deploy it.';
        return {
            content: [
                {
                    type: 'text',
                    text: `Reported ${changes.length} change(s) for "${name}" (sigil ${chatId}) — mode: ${mode}: ${upserts} upsert, ${deletes} delete.\n\n` +
                        `${lines.join('\n')}\n\n` +
                        `Sigil updated at ${WEB_URL} (Sigils → ${chatId.slice(0, 8)} · ${name}).${nextHint}`
                }
            ]
        };
    }
);

server.registerTool(
    'deploy_sigil',
    {
        title: 'Deploy a design sigil to AWS',
        description:
            'Deploy the current DESIGN sigil to AWS. Call this when the user has reviewed the ' +
            'design in the web and wants it built for real. This does NOT create resources by ' +
            'itself — Sigilum has no AWS access. It marks the sigil as Live and returns ' +
            'the full resource spec; then YOU must create each resource in AWS using your own AWS ' +
            'tools (CLI/SDK), in dependency order (VPC → subnets/security groups → compute → data ' +
            'stores → wiring). As you create each one, call push_sigil (op:"upsert") with the ' +
            'SAME resource id it has in the design, filling in the real ARN/InstanceId in `arn`/' +
            '`details` and the live `state` — keep the id stable so the node is enriched, not ' +
            'duplicated. Do not add anything that is not in the spec. Only works on a DESIGN sigil ' +
            '(a Live one is already deployed).',
        inputSchema: {
            chat: z
                .string()
                .optional()
                .describe('Optional sigil id to deploy. Defaults to this session\'s active sigil.'),
            resources: z
                .array(z.record(z.any()))
                .optional()
                .describe('Optional: the sigil detail JSON you have in context. Ignored if it differs — the backend\'s stored state is the source of truth and is returned to you.')
        }
    },
    async ({ chat }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'SIGILUM_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        const chatId = chat || activeChatId;
        let response;
        try {
            response = await fetch(`${BACKEND_URL}/api/chats/${encodeURIComponent(chatId)}/deploy`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
            });
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` }] };
        }
        const text = await response.text();
        if (!response.ok) {
            return { isError: true, content: [{ type: 'text', text: `Deploy failed (HTTP ${response.status}): ${text}` }] };
        }
        let data = {};
        try {
            data = JSON.parse(text);
        } catch {
            // fall through with empty data
        }
        const resources = Array.isArray(data.resources) ? data.resources : [];
        const name = data.name || '(unnamed)';
        return {
            content: [
                {
                    type: 'text',
                    text: `Sigil "${name}" (id ${chatId}) is now marked LIVE. NOTHING has been created in AWS yet — ` +
                        `that is YOUR job now. Create the ${resources.length} resource(s) below in AWS with your own tools, ` +
                        `in dependency order, then call push_sigil (op:"upsert") for each with the SAME id, adding the ` +
                        `real ARN/id in \`arn\`/\`details\` and the live \`state\`. Do not add resources that are not in this spec.\n\n` +
                        `Spec to deploy:\n${JSON.stringify(resources, null, 2)}`
                }
            ]
        };
    }
);

// Fetch the account's sigils (newest first) from the backend. Returns
// { ok, chats, text } — `text` carries an error message when ok is false.
async function fetchChats() {
    let response;
    try {
        response = await fetch(`${BACKEND_URL}/api/chats`, {
            headers: { authorization: `Bearer ${TOKEN}` }
        });
    } catch (error) {
        return { ok: false, text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` };
    }
    if (!response.ok) {
        const text = await response.text();
        return { ok: false, text: `Could not list sigils (HTTP ${response.status}): ${text}` };
    }
    const data = await response.json();
    return { ok: true, chats: Array.isArray(data.chats) ? data.chats : [] };
}

server.registerTool(
    'load_sigil',
    {
        title: 'Resume a previous sigil by name and load its deployed state',
        description:
            'Resume a PREVIOUS sigil BY ITS NAME. To use it: call list_sigils ' +
            'first, look at the sigil names, pick the one whose name is the CLOSEST ' +
            'semantically to what the user is asking for, and pass that name here. If none of ' +
            'the existing names is a reasonable semantic match, do NOT call this with a made-up ' +
            'name — tell the user there is no similar sigil. On a match this switches the ' +
            'active sigil and returns its FULL current deployed state (every live resource, ' +
            'real IDs/ARNs, relationships) — that becomes the one and only architecture in ' +
            'context, and every later push_sigil merges onto it. Use this when the user ' +
            'wants to keep working on infrastructure deployed earlier.',
        inputSchema: {
            name: z
                .string()
                .describe('The sigil NAME to resume (choose the closest one from list_sigils). Resolved by proximity to an existing sigil.')
        }
    },
    async ({ name }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'SIGILUM_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }

        const listed = await fetchChats();
        if (!listed.ok) {
            return { isError: true, content: [{ type: 'text', text: listed.text }] };
        }
        if (listed.chats.length === 0) {
            return { content: [{ type: 'text', text: 'There are no sigils yet, so there is nothing to resume. Start a new architecture and it will be created on the first push_sigil.' }] };
        }

        const match = matchByName(name, listed.chats);
        if (!match) {
            const available = listed.chats.map((c) => `• ${c.name || '(unnamed)'}`).join('\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: `No sigil is semantically similar to "${name}". Tell the user there is no matching sigil and, if useful, offer the available ones:\n${available}`
                    }
                ]
            };
        }

        let response;
        try {
            response = await fetch(`${BACKEND_URL}/api/chats/${encodeURIComponent(match.chatId)}`, {
                headers: { authorization: `Bearer ${TOKEN}` }
            });
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` }] };
        }
        if (!response.ok) {
            const text = await response.text();
            return { isError: true, content: [{ type: 'text', text: `Could not load sigil "${match.name}" (HTTP ${response.status}): ${text}` }] };
        }
        const data = await response.json();
        const resources = Array.isArray(data.resources) ? data.resources : [];
        const resolvedName = data.name || match.name || '(unnamed)';
        const isLive = data.deployed === true;
        // Adopt the sigil so follow-up changes apply onto it.
        activeChatId = match.chatId;
        const modeLine = isLive
            ? `This sigil is LIVE: the ${resources.length} resource(s) below are ACTUALLY deployed in AWS right now ` +
              `(real IDs/ARNs, state and relationships). Report changes with push_sigil and they merge onto this live state.`
            : `This sigil is a DESIGN: the ${resources.length} resource(s) below are a sketch — NOTHING exists in AWS yet. ` +
              `Keep refining it with push_sigil; when the user approves, call deploy_sigil to deploy it.`;
        return {
            content: [
                {
                    type: 'text',
                    text: `Loaded the sigil "${resolvedName}" (id ${match.chatId}). ` +
                        `THIS is now the ONLY active architecture and the only valid context. ${modeLine} ` +
                        `From now on, EVERYTHING the user asks refers EXCLUSIVELY to this architecture; any ` +
                        `architecture worked on earlier in this session belongs to a different sigil and must be ignored.\n\n` +
                        `Current resources:\n${JSON.stringify(resources, null, 2)}`
                }
            ]
        };
    }
);

server.registerTool(
    'list_sigils',
    {
        title: 'List previous sigils',
        description:
            'List the sigils available for your account (newest first), each with ' +
            'its name, id, and last-updated time. This is the FIRST step when the user wants to ' +
            'resume earlier work: look at the names, pick the one closest semantically to what ' +
            'the user means, then pass that NAME to load_sigil (load_sigil resolves it by ' +
            'proximity). If no name is a reasonable match, tell the user there is no similar sigil.',
        inputSchema: {}
    },
    async () => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'SIGILUM_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        const listed = await fetchChats();
        if (!listed.ok) {
            return { isError: true, content: [{ type: 'text', text: listed.text }] };
        }
        if (listed.chats.length === 0) {
            return { content: [{ type: 'text', text: 'No previous sigils yet.' }] };
        }
        const lines = listed.chats.map(
            (c) => `• ${c.name || '(unnamed)'} [${c.deployed ? 'LIVE' : 'DESIGN'}]${c.updatedAt ? ` (updated ${c.updatedAt})` : ''} — id ${c.chatId}`
        );
        return {
            content: [
                {
                    type: 'text',
                    text: `Sigils (newest first):\n${lines.join('\n')}\n\nPass the closest NAME to load_sigil to resume it.`
                }
            ]
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
