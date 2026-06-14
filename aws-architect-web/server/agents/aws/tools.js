'use strict';

// AWS agent tools, expressed in the generic tool format consumed by
// shared/toolLoop.js: { name, description, input_schema, run }. Each tool's run()
// owns its side effects — retry-on-throttle status, intercepting CLI answers into
// the workflow/queue, emitting deploy-log entries, and trimming output.

import {
    listAnthropicTools,
    callAwsWithRetry,
    extractOutputMessages,
    trimResultText,
    isFatalCredentialError
} from './mcp.js';
import * as store from '../../projectStore.js';
import { FatalToolError } from '../shared/errors.js';

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
        // Only fatal credential/session errors abort the run. Per-resource
        // permission denials fall through and are reported to the model as a
        // normal tool error so it can skip that resource and deploy the rest.
        if (isFatalCredentialError(errText)) {
            throw new FatalToolError(`AWS credentials error — ${errText}`);
        }
        emit({ type: 'deploy-log', entry: { tool: name, ok: false, summary: errText } });
        return { content: `Tool execution failed: ${errText}`, is_error: true };
    }

    // Intercept CLI answers into workflow/queue and surface them live.
    const operations = extractOutputMessages(result.structuredContent);
    if (operations.length > 0) {
        // Only fatal credential errors abort. Permission denials (e.g. an account
        // with no RDS rights) stay in the queue WITH their error so the reconciler
        // can omit that resource from the deployed diagram, and are surfaced as a
        // failed log entry — the model continues with the rest of the architecture.
        const fatalOp = operations.find((op) => op.error && isFatalCredentialError(op.error));
        if (fatalOp) {
            throw new FatalToolError(`AWS credentials error — ${fatalOp.error}`);
        }
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
