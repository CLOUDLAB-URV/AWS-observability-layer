'use strict';

// Generic agentic tool-use loop, reusable by any agent that declares tools.
//
// A tool is a plain object: { name, description, input_schema, run }, where
//   run: async (input, ctx) => { content: string, is_error?: boolean }
// owns all tool-specific side effects (the loop only orchestrates). `ctx` carries
// { emit } so a tool can stream its own status/log events.
//
// FatalToolErrors (auth failures, etc.) are re-thrown so they propagate to the
// caller rather than being fed back to the model as a retryable tool_result.

import { FatalToolError } from './errors.js';

export async function runToolLoop({ client, model, system, tools, messages, emit, maxTurns = 60 }) {
    const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

    for (let turn = 0; turn < maxTurns; turn++) {
        const stream = client.messages.stream({
            model,
            max_tokens: 16000,
            system,
            tools: toolDefs,
            messages
        });

        stream.on('text', (delta) => emit({ type: 'chat-delta', text: delta }));

        const message = await stream.finalMessage();
        messages.push({ role: 'assistant', content: message.content });

        if (message.stop_reason === 'pause_turn') {
            continue;
        }
        if (message.stop_reason !== 'tool_use') {
            break;
        }

        // Independent tool_use blocks from one turn run concurrently (each tool
        // call is an AWS round-trip; overlapping them cuts wall-clock time). Results
        // are reassembled in the model's original block order so the transcript is
        // deterministic. A FatalToolError from any call rejects the batch and
        // propagates to the caller (re-thrown below) instead of being fed back.
        const toolBlocks = message.content.filter((block) => block.type === 'tool_use');

        let fatal = null;
        const settled = await Promise.all(
            toolBlocks.map(async (block) => {
                emit({ type: 'status', text: `Running ${block.name}…` });
                const tool = toolsByName.get(block.name);
                try {
                    const result = tool
                        ? await tool.run(block.input, { emit })
                        : { content: `Unknown tool: ${block.name}`, is_error: true };
                    return { block, result };
                } catch (error) {
                    if (error instanceof FatalToolError) {
                        fatal = error; // re-thrown after the batch settles
                        return { block, result: { content: 'aborted', is_error: true } };
                    }
                    const errText = error instanceof Error ? error.message : String(error);
                    return { block, result: { content: `Tool execution failed: ${errText}`, is_error: true } };
                }
            })
        );
        if (fatal) throw fatal;

        const toolResults = settled.map(({ block, result }) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.content || '(no output)',
            is_error: Boolean(result.is_error)
        }));

        messages.push({ role: 'user', content: toolResults });
    }

    return messages;
}
