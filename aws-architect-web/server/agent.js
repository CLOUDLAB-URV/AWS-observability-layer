'use strict';

import Anthropic from '@anthropic-ai/sdk';
import { listAnthropicTools, callMcpTool, extractOutputMessages } from './mcpClient.js';
import { buildStateMergePrompt, buildPreviewSystemPrompt } from './promptStore.js';
import { stripCodeFences } from './diagram.js';
import * as store from './projectStore.js';

const PREVIEW_MODEL = 'claude-haiku-4-5';
const MERGE_MODEL = 'claude-haiku-4-5';
const DEPLOY_MODEL = 'claude-sonnet-4-6';
const D2_MARKER = '===D2===';

// Lazy so the server can boot (and render diagrams) without ANTHROPIC_API_KEY set.
let anthropicClient = null;
function getAnthropic() {
    if (!anthropicClient) {
        anthropicClient = new Anthropic();
    }
    return anthropicClient;
}

// ---------------------------------------------------------------------------
// Preview mode: chat-driven D2 design, no AWS tools, cheap model.
// Returns the updated D2 code (or null when the reply contained none).
// ---------------------------------------------------------------------------
export async function runPreviewTurn(history, userText, emit) {
    const currentD2 = await store.readDiagram();
    const system = await buildPreviewSystemPrompt(currentD2);

    history.push({ role: 'user', content: userText });

    const stream = getAnthropic().messages.stream({
        model: PREVIEW_MODEL,
        max_tokens: 16000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: history
    });

    // Stream the explanation live, but keep the D2 part (after the marker)
    // out of the chat panel.
    let buffered = '';
    let emitted = 0;
    let markerSeen = false;
    stream.on('text', (delta) => {
        if (markerSeen) {
            return;
        }
        buffered += delta;
        const markerIndex = buffered.indexOf(D2_MARKER);
        if (markerIndex !== -1) {
            markerSeen = true;
            if (markerIndex > emitted) {
                emit({ type: 'chat-delta', text: buffered.slice(emitted, markerIndex) });
            }
            return;
        }
        // Hold back a marker-length tail so a marker split across chunks
        // never leaks into the chat panel.
        const safeEnd = Math.max(emitted, buffered.length - (D2_MARKER.length - 1));
        if (safeEnd > emitted) {
            emit({ type: 'chat-delta', text: buffered.slice(emitted, safeEnd) });
            emitted = safeEnd;
        }
    });

    const message = await stream.finalMessage();
    const fullText = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

    history.push({ role: 'assistant', content: message.content });

    const markerIndex = fullText.indexOf(D2_MARKER);
    if (markerIndex === -1) {
        return null;
    }

    const d2Code = stripCodeFences(fullText.slice(markerIndex + D2_MARKER.length));
    if (!d2Code) {
        return null;
    }

    await store.writeDiagram(d2Code);
    return d2Code;
}

// ---------------------------------------------------------------------------
// Agent loop with AWS MCP tools (deploy + deployed-mode changes).
// Every call_aws result is intercepted into workflow/queue and surfaced live.
// ---------------------------------------------------------------------------
export async function runAwsAgent(taskPrompt, emit) {
    const tools = await listAnthropicTools();
    const currentD2 = await store.readDiagram();

    const system = [
        'You are an autonomous AWS deployment agent operating against a real AWS account.',
        'You are given an architecture described as a D2 diagram and a task. Use the available AWS tools to execute it.',
        'You are operating autonomously: the user cannot answer questions mid-task. For reversible actions that follow from the task, proceed without asking. Only run commands needed for the requested change — no unrequested cleanup or extras.',
        'Use suggest_aws_commands when unsure of the exact CLI syntax, then call_aws to execute.',
        'When the task is complete, summarize briefly what was created or changed.',
        '',
        'Current architecture (D2):',
        '<CURRENT_D2_STATE>',
        currentD2 || '(empty diagram)',
        '</CURRENT_D2_STATE>'
    ].join('\n');

    const messages = [{ role: 'user', content: taskPrompt }];

    for (let turn = 0; turn < 60; turn++) {
        const stream = getAnthropic().messages.stream({
            model: DEPLOY_MODEL,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            tools,
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

        const toolResults = [];
        for (const block of message.content) {
            if (block.type !== 'tool_use') {
                continue;
            }

            emit({ type: 'status', text: `Running ${block.name}…` });
            let result;
            try {
                result = await callMcpTool(block.name, block.input);
            } catch (error) {
                const errText = error instanceof Error ? error.message : String(error);
                emit({ type: 'deploy-log', entry: { tool: block.name, ok: false, summary: errText } });
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: `Tool execution failed: ${errText}`,
                    is_error: true
                });
                continue;
            }

            // Intercept CLI answers into workflow/queue (replaces the proxy's
            // stdout sniffing in the extension setup).
            const operations = extractOutputMessages(result.structuredContent);
            if (operations.length > 0) {
                await store.appendOperations(operations);
                for (const op of operations) {
                    emit({
                        type: 'deploy-log',
                        entry: { tool: block.name, ok: !op.error, summary: op.action, error: op.error }
                    });
                }
            }

            const resultText = Array.isArray(result.content)
                ? result.content
                      .filter((part) => part.type === 'text')
                      .map((part) => part.text)
                      .join('\n')
                : JSON.stringify(result.content ?? result);

            toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: resultText || '(no output)',
                is_error: Boolean(result.isError)
            });
        }

        messages.push({ role: 'user', content: toolResults });
    }
}

// ---------------------------------------------------------------------------
// State merge: confirmed diagram + queued CLI answers -> deployed-state D2.
// Reuses the extension's prompts/default.md verbatim (state-merge.md).
// ---------------------------------------------------------------------------
export async function runStateMerge(emit) {
    const [currentD2, queue] = await Promise.all([store.readDiagram(), store.readQueue()]);
    if (queue.length === 0) {
        emit({ type: 'status', text: 'No queued AWS operations — diagram unchanged.' });
        return null;
    }

    emit({ type: 'status', text: 'Reconciling diagram with deployed state…' });
    const prompt = await buildStateMergePrompt(currentD2, queue);
    await store.archivePrompt(prompt);

    const stream = getAnthropic().messages.stream({
        model: MERGE_MODEL,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
    });

    const message = await stream.finalMessage();
    const d2Code = stripCodeFences(
        message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
    );

    if (!d2Code) {
        return null;
    }

    await store.writeDiagram(d2Code);
    await store.clearQueue();
    return d2Code;
}
