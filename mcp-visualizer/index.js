#!/usr/bin/env node
'use strict';

// Distributable MCP server for the "Deployed state" feature. It is self-contained
// and does NOT run any AWS commands itself: the agent deploys with its own tools,
// then REPORTS what changed. After each deploy or modification, the agent calls
// push_deployment with only the DELTA — the resources it created/changed (upsert)
// or removed (delete). The AWS Architect Web backend keeps the authoritative,
// detailed state by applying those changes, and renders a live architecture
// diagram of what is actually deployed.
//
// Three tools:
//   - push_deployment : report the delta of changes (the only push tool).
//   - list_chats      : discover previous deployment diagrams (id + name).
//   - load_chat       : resume a previous diagram BY NAME (resolved by proximity)
//                       and load its full current deployed state into context.
//
// This server is dedicated to ONE web app, so the backend and web URLs are baked
// in here (the two constants below) — the only thing the user configures is their
// API token, via the VISUALIZER_TOKEN environment variable. To migrate the service
// to a new domain, change these two constants in one place and republish.
//
//   VISUALIZER_TOKEN  (env, required)  API token generated in the web UI
//   VISUALIZER_CHAT_ID (env, optional) pin a fixed chat id for this session

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { matchByName } from './match.js';

// --- Service endpoints (change here when migrating domains) ----------------
const BACKEND_URL = 'http://127.0.0.1:3001';
const WEB_URL = 'http://127.0.0.1:5173';
// ---------------------------------------------------------------------------

const TOKEN = process.env.VISUALIZER_TOKEN || '';

// Each chat gets its own isolated diagram, keyed by (user, chatId). One MCP process
// ≈ one chat, so we mint a chat id at startup (override with VISUALIZER_CHAT_ID).
// It is `let` so load_chat can switch the active chat to resume a previous one.
let activeChatId = process.env.VISUALIZER_CHAT_ID || randomUUID();

// Upload a batch of incremental changes for a chat to the visualizer backend
// ({ ok, text, data }). `nameHint` is an optional name hint for a brand-new session
// (the backend otherwise auto-names it); `chatId` is the storage key.
async function pushChanges(nameHint, changes, chatId) {
    if (!TOKEN) {
        return { ok: false, text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' };
    }
    let response;
    try {
        response = await fetch(`${BACKEND_URL}/api/chats/${encodeURIComponent(chatId)}/deployments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
            // `project` is the backend's name-hint field (kept for wire-compat).
            body: JSON.stringify({ project: nameHint, changes })
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

const server = new McpServer({ name: 'diagram-state-visualizer', version: '0.4.0' });

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
    'push_deployment',
    {
        title: 'Report deployed AWS changes to the visualizer',
        description:
            'Report what you changed in AWS so the live architecture diagram updates. Call this ' +
            'ONCE at the END of every deployment or modification you make in this chat, sending ' +
            'ONLY the DELTA — the resources that are new or changed, not the whole stack. Use ' +
            '`op:"upsert"` for resources you created or modified (include all their detail), and ' +
            '`op:"delete"` (just `type` + `id`) for resources you removed. ALWAYS include the ' +
            'relationships between services in `connections` (which resource each one talks to, ' +
            'with protocol and port) and containment in `vpc`/`subnet`, because the diagram draws ' +
            'those edges. The backend keeps the full, authoritative state by merging your changes ' +
            'onto what it already has — you only ever report the delta. Example: after creating ' +
            '3 EC2s, send 3 upserts; if the user later asks to remove one, send a single delete. ' +
            'The session is named automatically from the architecture (the user can rename it in ' +
            'the web UI), so you do not need to pass a name. By default the changes go to THIS ' +
            'session\'s diagram (a fresh diagram id per session); if you previously called ' +
            'load_chat, they merge onto that loaded diagram instead.',
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe('Optional name hint for a brand-new session. Leave unset — the backend auto-names it from the architecture.'),
            changes: z.array(changeSchema).describe('The resources that changed in this step (upsert/delete each).'),
            chat: z
                .string()
                .optional()
                .describe('Optional: target an explicit chat id (e.g. one from load_chat). Defaults to this session\'s chat — leave unset for normal use.')
        }
    },
    async ({ project, changes, chat }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        if (!Array.isArray(changes) || changes.length === 0) {
            return { isError: true, content: [{ type: 'text', text: 'No changes to report.' }] };
        }

        const chatId = chat || activeChatId;
        const result = await pushChanges(project, changes, chatId);
        if (!result.ok) {
            return { isError: true, content: [{ type: 'text', text: result.text }] };
        }

        // The backend returns the session name (auto-assigned for a new session).
        const name = result.data?.name || project || '(unnamed)';
        const upserts = changes.filter((c) => c.op !== 'delete').length;
        const deletes = changes.length - upserts;
        const lines = changes.map((c) =>
            c.op === 'delete' ? `− delete ${c.type} ${c.id}` : `+ upsert ${c.type} ${c.id}`
        );
        return {
            content: [
                {
                    type: 'text',
                    text: `Reported ${changes.length} change(s) for "${name}" (chat ${chatId}): ${upserts} upsert, ${deletes} delete.\n\n` +
                        `${lines.join('\n')}\n\n` +
                        `Live diagram updated at ${WEB_URL} (Deployed state → chat ${chatId.slice(0, 8)} · ${name}).`
                }
            ]
        };
    }
);

// Fetch the account's diagrams (newest first) from the backend. Returns
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
        return { ok: false, text: `Could not list diagrams (HTTP ${response.status}): ${text}` };
    }
    const data = await response.json();
    return { ok: true, chats: Array.isArray(data.chats) ? data.chats : [] };
}

server.registerTool(
    'load_chat',
    {
        title: 'Resume a previous diagram by name and load its deployed state',
        description:
            'Resume a PREVIOUS deployment diagram BY ITS NAME. To use it: call list_chats ' +
            'first, look at the diagram names, pick the one whose name is the CLOSEST ' +
            'semantically to what the user is asking for, and pass that name here. If none of ' +
            'the existing names is a reasonable semantic match, do NOT call this with a made-up ' +
            'name — tell the user there is no similar diagram. On a match this switches the ' +
            'active diagram and returns its FULL current deployed state (every live resource, ' +
            'real IDs/ARNs, relationships) — that becomes the one and only architecture in ' +
            'context, and every later push_deployment merges onto it. Use this when the user ' +
            'wants to keep working on infrastructure deployed earlier.',
        inputSchema: {
            name: z
                .string()
                .describe('The diagram NAME to resume (choose the closest one from list_chats). Resolved by proximity to an existing diagram.')
        }
    },
    async ({ name }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }

        const listed = await fetchChats();
        if (!listed.ok) {
            return { isError: true, content: [{ type: 'text', text: listed.text }] };
        }
        if (listed.chats.length === 0) {
            return { content: [{ type: 'text', text: 'There are no diagrams yet, so there is nothing to resume. Start a new architecture and it will be created on the first push_deployment.' }] };
        }

        const match = matchByName(name, listed.chats);
        if (!match) {
            const available = listed.chats.map((c) => `• ${c.name || '(unnamed)'}`).join('\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: `No diagram is semantically similar to "${name}". Tell the user there is no matching diagram and, if useful, offer the available ones:\n${available}`
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
            return { isError: true, content: [{ type: 'text', text: `Could not load diagram "${match.name}" (HTTP ${response.status}): ${text}` }] };
        }
        const data = await response.json();
        const resources = Array.isArray(data.resources) ? data.resources : [];
        const resolvedName = data.name || match.name || '(unnamed)';
        // Adopt the diagram so follow-up changes apply onto it.
        activeChatId = match.chatId;
        return {
            content: [
                {
                    type: 'text',
                    text: `Loaded the diagram "${resolvedName}" (chat ${match.chatId}). ` +
                        `THIS is now the ONLY active architecture in AWS and the only valid context. ` +
                        `The ${resources.length} resource(s) below are what is ACTUALLY deployed right now ` +
                        `(real IDs/ARNs, state and relationships). From now on, EVERYTHING the user asks ` +
                        `refers EXCLUSIVELY to this architecture; any architecture worked on earlier in this ` +
                        `session belongs to a different diagram and must be ignored. Report changes with ` +
                        `push_deployment and they will merge onto this state (it already targets this diagram).\n\n` +
                        `Current deployed resources:\n${JSON.stringify(resources, null, 2)}`
                }
            ]
        };
    }
);

server.registerTool(
    'list_chats',
    {
        title: 'List previous deployment diagrams',
        description:
            'List the deployment diagrams available for your account (newest first), each with ' +
            'its name, id, and last-updated time. This is the FIRST step when the user wants to ' +
            'resume earlier work: look at the names, pick the one closest semantically to what ' +
            'the user means, then pass that NAME to load_chat (load_chat resolves it by ' +
            'proximity). If no name is a reasonable match, tell the user there is no similar diagram.',
        inputSchema: {}
    },
    async () => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        const listed = await fetchChats();
        if (!listed.ok) {
            return { isError: true, content: [{ type: 'text', text: listed.text }] };
        }
        if (listed.chats.length === 0) {
            return { content: [{ type: 'text', text: 'No previous diagrams yet.' }] };
        }
        const lines = listed.chats.map(
            (c) => `• ${c.name || '(unnamed)'}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''} — id ${c.chatId}`
        );
        return {
            content: [
                {
                    type: 'text',
                    text: `Diagrams (newest first):\n${lines.join('\n')}\n\nPass the closest NAME to load_chat to resume it.`
                }
            ]
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
