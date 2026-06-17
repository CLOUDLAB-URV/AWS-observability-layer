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

// Shell control operators we refuse to run: this tool executes ONLY single AWS CLI
// commands, never pipelines/redirections/substitutions/chains. Blocking these
// prevents the command string from doing anything other than calling `aws`.
const SHELL_OPERATORS = /[;|&`\n\r]|\$\(|\$\{|>>|<<|>|</;

// Upload a batch of operations to the visualizer backend. Returns { ok, text }.
async function pushOperations(project, operations) {
    if (!TOKEN) {
        return { ok: false, text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' };
    }
    let response;
    try {
        response = await fetch(`${BACKEND_URL}/api/projects/${encodeURIComponent(project)}/deployments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ operations })
        });
    } catch (error) {
        return { ok: false, text: `Could not reach the visualizer backend at ${BACKEND_URL}: ${error?.message || error}` };
    }
    const text = await response.text();
    if (!response.ok) {
        return { ok: false, text: `Visualizer rejected the upload (HTTP ${response.status}): ${text}` };
    }
    return { ok: true, text };
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

const server = new McpServer({ name: 'diagram-state-visualizer', version: '0.1.0' });

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
            'create/update/delete operations that change deployed state.',
        inputSchema: {
            project: z.string().describe('Project name to group this deployment under (e.g. "my-api"). Reused across calls.'),
            commands: z
                .array(z.string())
                .describe('Full AWS CLI commands to execute in order, e.g. ["aws ec2 create-vpc --cidr-block 10.0.0.0/16", "aws sqs create-queue --queue-name orders"].')
        }
    },
    async ({ project, commands }) => {
        if (!TOKEN) {
            return { isError: true, content: [{ type: 'text', text: 'VISUALIZER_TOKEN is not set. Generate a token in the web UI and add it to this MCP server config.' }] };
        }
        if (!Array.isArray(commands) || commands.length === 0) {
            return { isError: true, content: [{ type: 'text', text: 'No commands to run.' }] };
        }

        const operations = [];
        for (const command of commands) {
            operations.push(await executeAwsCommand(command));
        }

        const result = await pushOperations(project, operations);
        const succeeded = operations.filter((op) => !op.error).length;
        const failed = operations.length - succeeded;

        // Return the per-command outcomes so the agent can read real IDs/ARNs and
        // chain follow-up commands, plus the visualizer link.
        const lines = operations.map((op) =>
            op.error ? `✗ ${op.action}\n   ${op.error}` : `✓ ${op.action}`
        );
        const tail = result.ok
            ? `\nVisualized at ${WEB_URL} (Deployed state → ${project}).`
            : `\n⚠ Commands ran but the visualizer upload failed: ${result.text}`;

        return {
            isError: !result.ok,
            content: [
                {
                    type: 'text',
                    text: `Ran ${operations.length} command(s) for "${project}": ${succeeded} ok, ${failed} failed.\n\n` +
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
            project: z.string().describe('Project name to group this deployment under (e.g. "my-api"). Reused across pushes.'),
            operations: z
                .array(
                    z.object({
                        action: z.string().describe('The full AWS CLI command that was executed.'),
                        resource_state: z.any().optional().describe('Key identifiers/state from the command response (resource id, ARN, name, type, region).'),
                        error: z.string().optional().describe('Error message if the command failed (omit on success).')
                    })
                )
                .describe('Every AWS CLI command executed in this deployment session.')
        }
    },
    async ({ project, operations }) => {
        const result = await pushOperations(project, operations);
        if (!result.ok) {
            return { isError: true, content: [{ type: 'text', text: result.text }] };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: `Pushed ${operations.length} operation(s) to project "${project}". ` +
                        `View the live deployed-state diagram at ${WEB_URL} (Deployed state → ${project}).`
                }
            ]
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
