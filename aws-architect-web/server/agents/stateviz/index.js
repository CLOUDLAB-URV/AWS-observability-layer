'use strict';

// State visualizer agent: given the real log of AWS operations pushed from a
// user's agent (via the MCP tool), generate a D2 diagram of the architecture as
// it is ACTUALLY deployed. Unlike the reconciler (which annotates an existing
// design), there is no prior diagram here — the D2 is built from scratch from the
// operations log. Cheap model (Gemini Flash), no tools.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { stripCodeFences } from '../../diagram.js';
import * as visualizerStore from '../../visualizerStore.js';

const D2_MARKER = '===D2===';

// Compact the operations log for the prompt: keep the command and error, and a
// trimmed resource_state (real IDs/ARNs matter, but full API payloads would blow
// the context window). Drops nothing semantically — just truncates verbose state.
function compactOperations(operations) {
    return operations.map((op) => {
        const entry = { action: op.action };
        if (op.error) {
            entry.error = String(op.error).split('\n')[0].slice(0, 240);
        }
        if (op.resource_state && typeof op.resource_state === 'object') {
            let state = JSON.stringify(op.resource_state);
            if (state.length > 1500) {
                state = `${state.slice(0, 1500)}…(truncated)`;
            }
            entry.resource_state = state;
        }
        return entry;
    });
}

// Pull the D2 out of the model response: prefer everything after the ===D2===
// marker, fall back to the whole text. Strips stray code fences defensively.
function extractD2(text) {
    const markerIndex = text.indexOf(D2_MARKER);
    const body = markerIndex === -1 ? text : text.slice(markerIndex + D2_MARKER.length);
    // Defensive: drop `//` comment lines the model sometimes emits — `//` is not a
    // D2 comment and the WASM compiler rejects it ("unexpected text after map key").
    // Safe because icon URLs live mid-line (`icon: "https://…"`), never line-start.
    const noComments = stripCodeFences(body)
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
    return noComments.trim();
}

// Builds (and persists) the deployed-state D2 for a (user, chat) from its
// operations log. Returns the D2 string ('' when nothing deployed / gen failed).
export async function runStateViz(userId, chatId) {
    const operations = await visualizerStore.readOperations(userId, chatId);
    if (operations.length === 0) {
        return '';
    }

    const prompt = fill(await loadPrompt(import.meta.url), {
        OPERATIONS_LOG: JSON.stringify(compactOperations(operations), null, 2)
    });

    const stream = getGemini().messages.stream({
        model: MODELS.reconciler,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
    });

    const message = await stream.finalMessage();
    const fullText = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

    const d2Code = extractD2(fullText);
    if (!d2Code) {
        return '';
    }

    await visualizerStore.writeDiagram(userId, chatId, d2Code);
    return d2Code;
}

// Suggest a short, human-readable session name describing the deployed architecture
// (e.g. "S3 + SQS pipeline"). Used to auto-name a brand-new session on its first
// deploy; the user can rename it later from the web. Returns '' on any failure so the
// caller can fall back gracefully. Cheap model, no tools.
export async function suggestSessionName(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return '';
    }

    const prompt =
        'You are naming an AWS architecture for a UI list. Given the AWS CLI ' +
        'operations below, reply with ONLY a short descriptive name of at most 5 ' +
        'words (no quotes, no punctuation at the ends, no trailing period). ' +
        'Examples: "S3 static site", "SQS order pipeline", "VPC with RDS".\n\n' +
        `Operations:\n${JSON.stringify(compactOperations(operations), null, 2)}`;

    try {
        const stream = getGemini().messages.stream({
            // Gemini 2.5 is a thinking model: a tiny budget gets consumed before any
            // text is emitted, so leave generous headroom for the short name.
            model: MODELS.reconciler,
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }]
        });
        const message = await stream.finalMessage();
        const text = message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();
        // Collapse to a single line and strip wrapping quotes the model may add.
        return text.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, 60);
    } catch {
        return '';
    }
}
