'use strict';

// Diagram explanation agent: given the current deployed-state inventory + the rendered
// D2, write a component-by-component prose explanation of the architecture (Markdown).
// Like runStateViz evolves the previous D2, this evolves the PREVIOUS explanation so a
// diagram change produces a minimal edit (new/changed parts only) instead of a brand
// new text. Cheap model (Gemini Flash), no tools. A separate, on-demand call — never
// part of the D2 generation path.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { compactResources } from '../stateviz/index.js';
import * as visualizerStore from '../../visualizerStore.js';

// Builds (and persists) the Markdown explanation for a (user, chat) from its current
// resource inventory + D2, evolving the previous explanation for stability. Returns
// the saved payload { markdown, generatedAt, basedOnUpdatedAt }, or null when there
// is nothing to explain / generation failed.
export async function runExplainDiagram(userId, chatId) {
    const [state, d2, previous, meta] = await Promise.all([
        visualizerStore.readState(userId, chatId),
        visualizerStore.readDiagram(userId, chatId),
        visualizerStore.readExplanation(userId, chatId),
        visualizerStore.readMeta(userId, chatId)
    ]);
    const resources = Object.values(state);
    if (resources.length === 0) {
        return null;
    }

    const prompt = fill(await loadPrompt(import.meta.url), {
        RESOURCE_INVENTORY: JSON.stringify(compactResources(resources), null, 2),
        D2: d2 ? d2.trim() : '(no diagram source available)',
        PREVIOUS_EXPLANATION: previous?.markdown
            ? previous.markdown.trim()
            : '(none — write the explanation from scratch)'
    });

    const stream = getGemini().messages.stream({
        model: MODELS.reconciler,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
    });

    const message = await stream.finalMessage();
    const markdown = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

    if (!markdown) {
        return null;
    }

    const payload = {
        markdown,
        generatedAt: new Date().toISOString(),
        // The diagram version this explanation reflects; the web compares it against
        // the live meta.updatedAt to know when the explanation is stale.
        basedOnUpdatedAt: meta.updatedAt || null
    };
    await visualizerStore.writeExplanation(userId, chatId, payload);
    return payload;
}
