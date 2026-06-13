'use strict';

// AWS agent tools, expressed in the generic tool format consumed by
// shared/toolLoop.js: { name, description, input_schema, run }. Each tool's run()
// owns its side effects — retry-on-throttle status, intercepting CLI answers into
// the workflow/queue, emitting deploy-log entries, and trimming output.

import {
    listAnthropicTools,
    callAwsWithRetry,
    extractOutputMessages,
    trimResultText
} from './mcp.js';
import * as store from '../../projectStore.js';

export async function getAwsTools() {
    const defs = await listAnthropicTools();
    return defs.map((def) => ({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
        run: (input, ctx) => runAwsTool(def.name, input, ctx)
    }));
}

async function runAwsTool(name, input, { emit }) {
    let result;
    try {
        result = await callAwsWithRetry(name, input, {
            onRetry: ({ reason, commands }) => {
                const detail = reason === 'throttled' && commands ? ` (${commands.length} command(s))` : '';
                emit({ type: 'status', text: `Retrying ${name} — ${reason}${detail}…` });
            }
        });
    } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        emit({ type: 'deploy-log', entry: { tool: name, ok: false, summary: errText } });
        return { content: `Tool execution failed: ${errText}`, is_error: true };
    }

    // Intercept CLI answers into workflow/queue and surface them live.
    const operations = extractOutputMessages(result.structuredContent);
    if (operations.length > 0) {
        await store.appendOperations(operations);
        for (const op of operations) {
            emit({
                type: 'deploy-log',
                entry: { tool: name, ok: !op.error, summary: op.action, error: op.error }
            });
        }
    }

    const resultText = Array.isArray(result.content)
        ? result.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
        : JSON.stringify(result.content ?? result);

    return { content: trimResultText(resultText), is_error: Boolean(result.isError) };
}
