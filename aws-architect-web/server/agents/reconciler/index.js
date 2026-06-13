'use strict';

// Reconciler agent: confirmed diagram + queued CLI traces -> deployed-state D2.
// Single-shot, no tools, cheap model (Gemini Flash). Returns the new D2, or null
// when there was nothing queued / nothing produced.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { stripCodeFences } from '../../diagram.js';
import * as store from '../../projectStore.js';

export async function runReconciler(emit) {
    const [currentD2, queue] = await Promise.all([store.readDiagram(), store.readQueue()]);
    if (queue.length === 0) {
        emit({ type: 'status', text: 'No queued AWS operations — diagram unchanged.' });
        return null;
    }

    emit({ type: 'status', text: 'Reconciling diagram with deployed state…' });
    const prompt = fill(await loadPrompt(import.meta.url), {
        D2_CURRENT_STATE: currentD2 || '(empty diagram)',
        AWS_COMMAND_QUEUE: JSON.stringify(queue, null, 2)
    });
    await store.archivePrompt(prompt);

    const stream = getGemini().messages.stream({
        model: MODELS.reconciler,
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
