'use strict';

// State visualizer agent: given the current deployed-state inventory (the resource
// map the backend maintains by applying the agent's incremental changes), generate
// a D2 diagram of the architecture as it is ACTUALLY deployed right now. To keep the
// picture stable across edits, the PREVIOUS diagram is passed in as a base so the
// model evolves it (same layout/style) instead of rebuilding from scratch. Cheap
// model (Gemini Flash), no tools.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { stripCodeFences } from '../../diagram.js';
import * as visualizerStore from '../../visualizerStore.js';

const D2_MARKER = '===D2===';

// Compact the resource inventory for the prompt: keep identity, state and ALL the
// relationship fields (connections / vpc / subnet — the diagram needs them to draw
// edges and containment), truncate the verbose `details` blob, and replace the `code`
// bodies with a tiny per-file summary. Both full forms are preserved in state.json; the
// model only needs to KNOW code exists (so it can mention it), not read every byte.
export function compactResources(resources) {
    return resources.map((resource) => {
        const { details, code, ...rest } = resource;
        const entry = { ...rest };
        if (details && typeof details === 'object') {
            let blob = JSON.stringify(details);
            if (blob.length > 1500) {
                blob = `${blob.slice(0, 1500)}…(truncated)`;
            }
            entry.details = blob;
        }
        if (Array.isArray(code) && code.length) {
            entry.code = code.map((file) => ({
                name: file?.name,
                language: file?.language,
                bytes: typeof file?.content === 'string' ? file.content.length : 0
            }));
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

// Builds (and persists) the deployed-state D2 for a (user, chat) from its current
// resource inventory, evolving the previous diagram for layout stability. Returns
// the D2 string ('' when nothing is deployed / generation failed).
export async function runStateViz(userId, chatId) {
    const [state, previousD2] = await Promise.all([
        visualizerStore.readState(userId, chatId),
        visualizerStore.readDiagram(userId, chatId)
    ]);
    const resources = Object.values(state);
    if (resources.length === 0) {
        return '';
    }

    const prompt = fill(await loadPrompt(import.meta.url), {
        RESOURCE_INVENTORY: JSON.stringify(compactResources(resources), null, 2),
        PREVIOUS_D2: previousD2 ? previousD2.trim() : '(none — build the diagram from scratch)'
    });

    const stream = getGemini().messages.stream({
        model: MODELS.stateviz,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }],
        user: userId // token-usage attribution
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
// deploy; the user can rename it later from the web. Takes the current resource
// inventory (Object.values of the state map). `avoid` lists names already taken by
// the user's other diagrams — the model is told not to reuse them (names are unique),
// so a retry after a collision picks a genuinely different name. Returns '' on any
// failure so the caller can fall back gracefully. Cheap model, no tools. `userId` is
// only for token-usage attribution.
export async function suggestSessionName(resources, userId = null, avoid = []) {
    if (!Array.isArray(resources) || resources.length === 0) {
        return '';
    }

    const avoidLine = Array.isArray(avoid) && avoid.length
        ? `\n\nThese names are already taken by other diagrams — do NOT reuse any of them, ` +
          `pick a clearly different name: ${avoid.map((n) => `"${n}"`).join(', ')}.`
        : '';
    const prompt =
        'You are naming an AWS architecture for a UI list. Given the deployed AWS ' +
        'resources below, reply with ONLY a short descriptive name of at most 5 ' +
        'words (no quotes, no punctuation at the ends, no trailing period). ' +
        'Examples: "S3 static site", "SQS order pipeline", "VPC with RDS".' +
        avoidLine +
        `\n\nResources:\n${JSON.stringify(compactResources(resources), null, 2)}`;

    try {
        const stream = getGemini().messages.stream({
            // Gemini 2.5 is a thinking model: a tiny budget gets consumed before any
            // text is emitted, so leave generous headroom for the short name.
            model: MODELS.stateviz,
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
            user: userId
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
