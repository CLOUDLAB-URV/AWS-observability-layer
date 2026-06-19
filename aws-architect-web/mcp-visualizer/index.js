#!/usr/bin/env node
'use strict';

// Distributable MCP server for the "Deployed state" feature. It is self-contained:
// it does NOT depend on any AWS MCP server. The agent gives it AWS CLI commands;
// this server runs them with the local AWS CLI (terminal), captures the results,
// and uploads the batch to the AWS Architect Web backend, which renders a live
// diagram of what is actually deployed.
//
// Two tools:
//   - deploy_and_visualize : run aws CLI commands here, then visualize (primary).
//   - push_deployment      : visualize commands the agent already ran elsewhere.
//
// This server is dedicated to ONE web app, so the backend and web URLs are baked
// in here (the two constants below) — the only thing the user configures is their
// API token, via the VISUALIZER_TOKEN environment variable. To migrate the service
// to a new domain, change these two constants in one place and republish.
//
//   VISUALIZER_TOKEN  (env, required)  API token generated in the web UI
//   AWS_REGION        (env, optional)  default region for the AWS CLI (us-east-1)
//   AWS_PROFILE       (env, optional)  AWS profile to use for the CLI

import process from 'node:process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const exec = promisify(execCb);

// --- Service endpoints (change here when migrating domains) ----------------
const BACKEND_URL = 'http://127.0.0.1:3001';
const WEB_URL = 'http://127.0.0.1:5173';
// ---------------------------------------------------------------------------

const TOKEN = process.env.VISUALIZER_TOKEN || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Each chat gets its own isolated diagram, keyed by (user, chatId). One MCP process
// ≈ one chat, so we mint a chat id at startup (override with VISUALIZER_CHAT_ID).
// It is `let` so load_chat can switch the active chat to resume a previous one.
let activeChatId = process.env.VISUALIZER_CHAT_ID || randomUUID();

// Shell control operators we refuse to run: this tool executes ONLY single AWS CLI
// commands, never pipelines/redirections/substitutions/chains. Blocking these
// prevents the command string from doing anything other than calling `aws`.
const SHELL_OPERATORS = /[;|&`\n\r]|\$\(|\$\{|>>|<<|>|</;

// Upload a batch of operations for a chat to the visualizer backend ({ ok, text }).
// `project` is a friendly label; `chatId` is the storage key (defaults to active).
async function pushOperations(project, operations, chatId) {
    if (!TOKEN) {
        return { ok: false, text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' };
    }
    let response;
    try {
        response = await fetch(`${BACKEND_URL}/api/chats/${encodeURIComponent(chatId)}/deployments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ project, operations })
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

// Run one AWS CLI command via the local terminal and normalize it into the
// operation shape the visualizer expects ({ action, resource_state?, error? }).
async function executeAwsCommand(rawCommand) {
    const command = String(rawCommand).trim();
    if (!/^aws\s/.test(command)) {
        return { action: command, error: 'Rejected: command must start with "aws".' };
    }
    if (SHELL_OPERATORS.test(command)) {
        return { action: command, error: 'Rejected: shell operators (| & ; ` $() <> newlines) are not allowed.' };
    }

    // Ensure JSON output so resource_state is structured, unless the agent set a format.
    const withJson = /--output(\s|=)/.test(command) ? command : `${command} --output json`;

    try {
        const { stdout } = await exec(withJson, {
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || AWS_REGION }
        });
        const out = stdout.trim();
        let resourceState;
        if (out) {
            try {
                resourceState = JSON.parse(out);
            } catch {
                resourceState = { output: out.slice(0, 4000) };
            }
        }
        return { action: command, ...(resourceState !== undefined ? { resource_state: resourceState } : {}) };
    } catch (error) {
        // Non-zero exit (AWS error / access denied / validation). Capture stderr.
        const detail = (error?.stderr || error?.message || String(error)).trim();
        return { action: command, error: detail.slice(0, 1000) };
    }
}

const server = new McpServer({ name: 'diagram-state-visualizer', version: '0.2.0' });

server.registerTool(
    'deploy_and_visualize',
    {
        title: 'Run AWS CLI commands and visualize the deployment',
        description:
            'Execute AWS CLI commands directly (no AWS MCP server needed) and render a live ' +
            'architecture diagram of what is actually deployed. Pass a list of full "aws …" ' +
            'CLI commands; this tool runs each with the local AWS CLI, captures the result, ' +
            'and uploads the batch to the Deployed-State Visualizer. Commands run in order — ' +
            'so when a command needs an id/ARN from a previous one, call this tool again in a ' +
            'follow-up step with the resolved value (the previous results are returned to you). ' +
            'Each command must be a single "aws" command (no pipes, redirects, chaining, or ' +
            'substitutions). Avoid read-only describe/list/get commands — only include the ' +
            'create/update/delete operations that change deployed state. The session is ' +
            'named automatically from the architecture (the user can rename it in the web UI), ' +
            'so you do not need to pass a name.',
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe('Optional name hint for a brand-new session. Leave unset — the backend auto-names it from the architecture.'),
            commands: z
                .array(z.string())
                .describe('Full AWS CLI commands to execute in order, e.g. ["aws ec2 create-vpc --cidr-block 10.0.0.0/16", "aws sqs create-queue --queue-name orders"].'),
            chat: z
                .string()
                .optional()
                .describe('Optional: target an explicit chat id (e.g. one from load_chat). Defaults to this session\'s chat — leave unset for normal use.')
        }
    },
    async ({ project, commands, chat }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        if (!Array.isArray(commands) || commands.length === 0) {
            return { isError: true, content: [{ type: 'text', text: 'No commands to run.' }] };
        }

        const chatId = chat || activeChatId;
        const operations = [];
        for (const command of commands) {
            operations.push(await executeAwsCommand(command));
        }

        const result = await pushOperations(project, operations, chatId);
        const succeeded = operations.filter((op) => !op.error).length;
        const failed = operations.length - succeeded;
        const name = result.data?.name || project || '(unnamed)';

        // Return the per-command outcomes so the agent can read real IDs/ARNs and
        // chain follow-up commands, plus the visualizer link.
        const lines = operations.map((op) =>
            op.error ? `✗ ${op.action}\n   ${op.error}` : `✓ ${op.action}`
        );
        const tail = result.ok
            ? `\nVisualized at ${WEB_URL} (Deployed state → chat ${chatId.slice(0, 8)} · ${name}).`
            : `\n⚠ Commands ran but the visualizer upload failed: ${result.text}`;

        return {
            isError: !result.ok,
            content: [
                {
                    type: 'text',
                    text: `Ran ${operations.length} command(s) for "${name}" (chat ${chatId}): ${succeeded} ok, ${failed} failed.\n\n` +
                        `${lines.join('\n')}\n` +
                        `${tail}\n\n` +
                        `Results:\n${JSON.stringify(operations, null, 2)}`
                }
            ]
        };
    }
);

server.registerTool(
    'push_deployment',
    {
        title: 'Push an already-run deployment to the visualizer',
        description:
            'Visualize AWS resources you ALREADY deployed yourself (e.g. you ran the aws ' +
            'commands in your own terminal). Renders a live architecture diagram of what is ' +
            'live in AWS. Pass EVERY aws CLI command you executed (one entry per command), ' +
            'including key identifiers (IDs/ARNs/names) from each response in resource_state, ' +
            'and an error string for any command that failed. Omit read-only describe/list/get ' +
            'commands. If you want this tool to RUN the commands for you instead, use ' +
            'deploy_and_visualize.',
        inputSchema: {
            project: z
                .string()
                .optional()
                .describe('Optional name hint for a brand-new session. Leave unset — the backend auto-names it from the architecture.'),
            operations: z
                .array(
                    z.object({
                        action: z.string().describe('The full AWS CLI command that was executed.'),
                        resource_state: z.any().optional().describe('Key identifiers/state from the command response (resource id, ARN, name, type, region).'),
                        error: z.string().optional().describe('Error message if the command failed (omit on success).')
                    })
                )
                .describe('Every AWS CLI command executed in this deployment session.'),
            chat: z
                .string()
                .optional()
                .describe('Optional: target an explicit chat id (e.g. one from load_chat). Defaults to this session\'s chat — leave unset for normal use.')
        }
    },
    async ({ project, operations, chat }) => {
        const chatId = chat || activeChatId;
        const result = await pushOperations(project, operations, chatId);
        if (!result.ok) {
            return { isError: true, content: [{ type: 'text', text: result.text }] };
        }
        const name = result.data?.name || project || '(unnamed)';
        return {
            content: [
                {
                    type: 'text',
                    text: `Pushed ${operations.length} operation(s) to "${name}" (chat ${chatId}). ` +
                        `View the live deployed-state diagram at ${WEB_URL} (Deployed state → chat ${chatId.slice(0, 8)} · ${name}).`
                }
            ]
        };
    }
);

server.registerTool(
    'load_chat',
    {
        title: 'Resume a previous chat and load its deployed-state context',
        description:
            'Resume a PREVIOUS deployment session: switches this session to an existing ' +
            'chat and returns its full operations log (every aws command run + the resulting ' +
            'resource_state with real IDs/ARNs). Call this when the user wants to continue ' +
            'working on infrastructure they deployed earlier, so you know what already exists ' +
            'and can reference those IDs/ARNs in new commands. After loading, subsequent ' +
            'deploy_and_visualize / push_deployment calls accumulate into THIS chat and the ' +
            'diagram links the new resources to the existing ones automatically. Use list_chats ' +
            'first to find the chat id.',
        inputSchema: {
            chat: z.string().describe('The chat id to resume (from list_chats).')
        }
    },
    async ({ chat }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        let response;
        try {
            response = await fetch(`${BACKEND_URL}/api/chats/${encodeURIComponent(chat)}`, {
                headers: { authorization: `Bearer ${TOKEN}` }
            });
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` }] };
        }
        if (!response.ok) {
            const text = await response.text();
            return { isError: true, content: [{ type: 'text', text: `Could not load chat "${chat}" (HTTP ${response.status}): ${text}` }] };
        }
        const data = await response.json();
        const operations = Array.isArray(data.operations) ? data.operations : [];
        // Adopt the chat so follow-up deployments accumulate into it.
        activeChatId = chat;
        return {
            content: [
                {
                    type: 'text',
                    text: `Resumed chat ${chat}${data.name ? ` ("${data.name}")` : ''} with ${operations.length} prior operation(s). ` +
                        `New deployments will link to these existing resources.\n\n` +
                        `Existing operations:\n${JSON.stringify(operations, null, 2)}`
                }
            ]
        };
    }
);

server.registerTool(
    'list_chats',
    {
        title: 'List previous deployment chats',
        description:
            'List the deployment chats available for your account (newest first), each with its ' +
            'chat id, friendly label, and last-updated time. Use this to find a chat id to pass ' +
            'to load_chat when resuming earlier work.',
        inputSchema: {}
    },
    async () => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        let response;
        try {
            response = await fetch(`${BACKEND_URL}/api/chats`, {
                headers: { authorization: `Bearer ${TOKEN}` }
            });
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` }] };
        }
        if (!response.ok) {
            const text = await response.text();
            return { isError: true, content: [{ type: 'text', text: `Could not list chats (HTTP ${response.status}): ${text}` }] };
        }
        const data = await response.json();
        const chats = Array.isArray(data.chats) ? data.chats : [];
        if (chats.length === 0) {
            return { content: [{ type: 'text', text: 'No previous chats yet.' }] };
        }
        const lines = chats.map(
            (c) => `• ${c.chatId}${c.name ? ` — ${c.name}` : ''}${c.updatedAt ? ` (updated ${c.updatedAt})` : ''}`
        );
        return {
            content: [
                {
                    type: 'text',
                    text: `Chats (newest first):\n${lines.join('\n')}\n\nPass a chat id to load_chat to resume it.`
                }
            ]
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
