'use strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let clientPromise = null;

async function connect() {
    const transport = new StdioClientTransport({
        command: process.env.AWS_MCP_COMMAND || 'uvx',
        args: process.env.AWS_MCP_ARGS
            ? process.env.AWS_MCP_ARGS.split(' ')
            : ['awslabs.aws-api-mcp-server@latest'],
        env: {
            ...process.env,
            AWS_PROFILE: process.env.AWS_PROFILE || 'apozo-cloudlab',
            AWS_REGION: process.env.AWS_REGION || 'us-east-1'
        },
        stderr: 'inherit'
    });

    const client = new Client({ name: 'aws-architect-web', version: '0.1.0' });
    await client.connect(transport);
    return client;
}

export function getMcpClient() {
    if (!clientPromise) {
        clientPromise = connect().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
}

// MCP tool definitions mapped to Messages API tool shape.
export async function listAnthropicTools() {
    const client = await getMcpClient();
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema
    }));
}

export async function callMcpTool(name, args) {
    const client = await getMcpClient();
    return client.callTool({ name, arguments: args ?? {} });
}

// Transient AWS failures worth retrying (throttling / capacity / 5xx). Matched
// against per-command error strings as well as thrown transport errors.
const TRANSIENT_AWS_RE = /Throttl|RequestLimitExceeded|TooManyRequests(?:Exception)?|ServiceUnavailable|RequestTimeout|\b5\d\d\b/i;

export function isTransientAwsError(text) {
    return TRANSIENT_AWS_RE.test(String(text ?? ''));
}

// Fatal CREDENTIAL/session failures: they invalidate *who you are*, so every
// subsequent call is pointless — abort the whole run and ask the user to
// re-authenticate. NOTE: this deliberately excludes per-resource authorization
// denials (AccessDenied / UnauthorizedOperation). Those mean "you're allowed in,
// but not allowed to do THIS" — they must NOT abort the deploy; the resource is
// skipped and the rest of the architecture still goes up. See isPermissionDenied.
const FATAL_CREDENTIAL_RE = /Token has expired|token.*expired|refresh failed|InvalidSignatureException|UnrecognizedClientException|ExpiredTokenException|InvalidClientTokenId|AuthFailure|sso.*expired/i;

export function isFatalCredentialError(text) {
    return FATAL_CREDENTIAL_RE.test(String(text ?? ''));
}

// Per-resource authorization denials: the caller is authenticated, but lacks the
// IAM permission for this specific action/service (e.g. an account with no RDS
// rights). These are recoverable at the architecture level — skip the resource
// and keep deploying the rest. The reconciler then omits it from the diagram.
const PERMISSION_DENIED_RE = /AccessDenied|AccessDeniedException|UnauthorizedOperation|not authorized to perform/i;

export function isPermissionDenied(text) {
    return PERMISSION_DENIED_RE.test(String(text ?? ''));
}

// Per-command results returned by call_aws live in structuredContent.result[],
// each tagged with its cli_command. Index them so we can retry only the throttled
// subset of a batch instead of re-running commands that already succeeded.
function indexResultsByCommand(structuredContent) {
    const map = new Map();
    if (structuredContent && Array.isArray(structuredContent.result)) {
        for (const res of structuredContent.result) {
            if (res && res.cli_command) {
                map.set(res.cli_command, res);
            }
        }
    }
    return map;
}

function throttledCommands(structuredContent) {
    const commands = [];
    if (structuredContent && Array.isArray(structuredContent.result)) {
        for (const res of structuredContent.result) {
            if (res && res.cli_command && res.error && isTransientAwsError(res.error)) {
                commands.push(res.cli_command);
            }
        }
    }
    return commands;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => Math.min(8000, 2 ** attempt * 500) + Math.floor(Math.random() * 250);

// call_aws wrapper that retries transient AWS failures with exponential backoff +
// jitter. Whole-call retry on a thrown transport error; partial retry of only the
// throttled subset (preserving order) when the batch returned per-command errors.
// `onRetry(info)` lets the caller surface progress to the UI.
export async function callAwsWithRetry(name, args, { maxAttempts = 4, onRetry } = {}) {
    let result = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            result = await callMcpTool(name, args);
        } catch (error) {
            if (attempt < maxAttempts - 1 && isTransientAwsError(error?.message)) {
                onRetry?.({ attempt: attempt + 1, reason: 'transport error' });
                await sleep(backoffMs(attempt));
                continue;
            }
            throw error;
        }

        const throttled = throttledCommands(result.structuredContent);
        if (throttled.length === 0 || attempt === maxAttempts - 1) {
            return result;
        }

        // Re-issue only the throttled commands, preserving their original order,
        // then splice the fresh results back over the throttled originals.
        onRetry?.({ attempt: attempt + 1, reason: 'throttled', commands: throttled });
        await sleep(backoffMs(attempt));

        const retryArgs = { ...args, cli_command: throttled };
        let retryResult;
        try {
            retryResult = await callMcpTool(name, retryArgs);
        } catch {
            return result; // keep partial batch results if the retry itself fails to transport
        }

        const fresh = indexResultsByCommand(retryResult.structuredContent);
        if (result.structuredContent && Array.isArray(result.structuredContent.result)) {
            result.structuredContent.result = result.structuredContent.result.map(
                (res) => (res?.cli_command && fresh.has(res.cli_command) ? fresh.get(res.cli_command) : res)
            );
        }
    }

    return result;
}

// Cap oversized CLI output before it re-enters the model context. AWS list/describe
// calls can dump megabytes; we keep the head and tail and mark the gap.
export function trimResultText(text, max = 12000) {
    const value = String(text ?? '');
    if (value.length <= max) {
        return value;
    }
    const head = value.slice(0, Math.floor(max * 0.7));
    const tail = value.slice(value.length - Math.floor(max * 0.2));
    const omitted = value.length - head.length - tail.length;
    return `${head}\n…[truncated ${omitted} chars — use --query/--max-items or max_results to narrow output]…\n${tail}`;
}

// Same extraction the extension does in serverService.extractOutputMessages(),
// applied to the structuredContent of a call_aws tool result.
export function extractOutputMessages(structuredContent) {
    const outputMessages = [];

    if (!structuredContent || structuredContent.suggestions) {
        return outputMessages;
    }

    if (Array.isArray(structuredContent.result)) {
        for (const res of structuredContent.result) {
            if (!res.cli_command) {
                continue;
            }

            let resourceState = {};
            if (res.response) {
                if (typeof res.response.as_json !== 'undefined' && res.response.as_json !== null) {
                    try {
                        const parsedJson = typeof res.response.as_json === 'string'
                            ? JSON.parse(res.response.as_json)
                            : res.response.as_json;
                        if (parsedJson && typeof parsedJson === 'object') {
                            // Drop transport noise and spent pagination cursors so the
                            // persisted resource_state stays lean.
                            for (const key of ['ResponseMetadata', 'NextToken', 'nextToken', 'Marker', 'NextMarker']) {
                                delete parsedJson[key];
                            }
                        }
                        resourceState = parsedJson;
                    } catch {
                        resourceState = res.response;
                    }
                } else {
                    resourceState = res.response;
                }
            }

            const outputMessage = {
                action: res.cli_command,
                resource_state: resourceState
            };
            // Errors surface in res.error OR inside res.response.error depending on MCP version.
            if (res.error) {
                outputMessage.error = res.error;
            } else if (typeof res.response?.error === 'string') {
                outputMessage.error = res.response.error;
            }
            outputMessages.push(outputMessage);
        }
    }

    return outputMessages;
}
