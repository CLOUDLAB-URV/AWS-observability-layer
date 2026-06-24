'use strict';

// Architect agent: chat-driven D2 design, no tools, cheap model (Gemini Flash).
// Streams the explanation live but keeps the D2 (after the ===D2=== marker) out
// of the chat panel. Returns the updated D2 code, or null when none was produced.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { stripCodeFences } from '../../diagram.js';
import * as store from '../../projectStore.js';

const D2_MARKER = '===D2===';

export async function runArchitectTurn(history, userText, emit) {
    const currentD2 = await store.readDiagram();
    const system = fill(await loadPrompt(import.meta.url), { D2_CURRENT_STATE: currentD2 || '(empty diagram)' });

    history.push({ role: 'user', content: userText });

    const stream = getGemini().messages.stream({
        model: MODELS.architect,
        max_tokens: 16000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: history
    });

    // Stream the explanation live, but hold back the D2 part (after the marker).
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
        // Hold back a marker-length tail so a marker split across chunks never leaks.
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
