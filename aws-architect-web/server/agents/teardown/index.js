'use strict';

// Teardown agent: destroys every AWS resource of the current architecture via the
// MCP tools (Gemini Pro). Reuses the AWS tools + the shared tool loop, plus an
// internal `report_teardown_status` tool through which the agent returns a
// structured verdict { complete, remaining[] } (cleaner than a streamed marker).
// One invocation = one best-effort pass; the graph node re-invokes with waits.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { runToolLoop } from '../shared/toolLoop.js';
import { getAwsTools } from '../aws/tools.js';

const REPORT_TOOL_NAME = 'report_teardown_status';

function reportTool(capture) {
    return {
        name: REPORT_TOOL_NAME,
        description:
            'Call this EXACTLY ONCE at the very end, after verifying deletions, to report the final teardown status. ' +
            'Set complete=true only if every resource of this architecture is confirmed gone.',
        input_schema: {
            type: 'object',
            properties: {
                complete: { type: 'boolean', description: 'true if all resources are verified deleted' },
                remaining: {
                    type: 'array',
                    description: 'resources still present (empty when complete)',
                    items: {
                        type: 'object',
                        properties: {
                            resource: { type: 'string', description: 'resource name / id / ARN' },
                            reason: { type: 'string', description: 'why it is still present' }
                        },
                        required: ['resource', 'reason']
                    }
                }
            },
            required: ['complete']
        },
        run: (input) => {
            capture.status = {
                complete: Boolean(input?.complete),
                remaining: Array.isArray(input?.remaining) ? input.remaining : []
            };
            return { content: 'status recorded' };
        }
    };
}

export async function runTeardownAgent({ diagram, deploymentLog, previousRemaining }, emit) {
    let system = fill(await loadPrompt(import.meta.url), {
        CURRENT_D2_STATE: diagram || '(empty diagram)',
        DEPLOYMENT_LOG: JSON.stringify(deploymentLog ?? [], null, 2)
    });

    if (Array.isArray(previousRemaining) && previousRemaining.length > 0) {
        system +=
            '\n\n### FOCUS — a previous attempt left these resources still present; concentrate on them:\n' +
            previousRemaining.map((r) => `- ${r.resource} (${r.reason})`).join('\n');
    }

    const capture = { status: null };
    const tools = [reportTool(capture), ...(await getAwsTools())];

    await runToolLoop({
        client: getGemini(),
        model: MODELS.teardown,
        system,
        tools,
        messages: [{ role: 'user', content: 'Tear down all resources for this architecture now.' }],
        emit,
        // One teardown pass = delete once, verify once, report. Cap turns low so a
        // single pass can never spin re-deleting already-gone resources.
        maxTurns: 16
    });

    return (
        capture.status ?? {
            complete: false,
            remaining: [{ resource: '(unknown)', reason: 'agent did not report a status' }]
        }
    );
}
