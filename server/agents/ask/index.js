'use strict';

// Diagram Q&A agent ("Ask"): answers a user question about ONE sigil's diagram, and
// nothing else. The sigil's state is read fresh on EVERY question so the answer always
// reflects the diagram at the moment of asking. Strictly read-only and informative —
// this path has no tools and no way to mutate the sigil; the system prompt additionally
// scopes the model to the diagram and marks the inventory/D2 as untrusted data (they are
// written by the external MCP agent). Cheap model (Gemini Flash).

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { compactResources } from '../stateviz/index.js';
import * as visualizerStore from '../../visualizerStore.js';

// How much of the persisted conversation the model sees (messages, user+assistant).
const MODEL_HISTORY_LIMIT = 12;

// Answers `question` about the (user, chat) diagram, streaming text deltas through
// `onText`. `history` is the persisted conversation ({ role, text } messages, oldest
// first). Returns the full answer text, or null when the sigil has nothing to ask about.
export async function runAskDiagram(userId, chatId, question, history = [], { onText } = {}) {
    const [state, d2, meta] = await Promise.all([
        visualizerStore.readState(userId, chatId),
        visualizerStore.readDiagram(userId, chatId),
        visualizerStore.readMeta(userId, chatId)
    ]);
    const resources = Object.values(state);
    if (resources.length === 0) {
        return null;
    }

    const divergent = resources.filter((r) => (r.deployed === true) !== meta.deployed).length;
    const system = fill(await loadPrompt(import.meta.url), {
        SIGIL_NAME: meta.name || meta.project || chatId,
        SIGIL_MODE: meta.deployed
            ? 'Live (the resources are deployed to AWS)'
            : 'Design (a sketch — nothing is deployed by default)',
        RESOURCE_COUNT: String(resources.length),
        DIVERGENT_NOTE: divergent > 0
            ? `${divergent} of ${resources.length} resources currently diverge from the sigil mode.`
            : 'All resources currently match the sigil mode.',
        RESOURCE_INVENTORY: JSON.stringify(compactResources(resources), null, 2),
        D2: d2 ? d2.trim() : '(no diagram source available)'
    });

    // Multi-turn context: the recent persisted turns, then the new question. The history
    // comes from the server's own chat.json — never from the client — so it cannot be
    // forged to smuggle instructions past the system prompt.
    const messages = history
        .slice(-MODEL_HISTORY_LIMIT)
        .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string' && m.text)
        .map((m) => ({ role: m.role, content: m.text }));
    messages.push({ role: 'user', content: question });

    const stream = getGemini().messages.stream({
        model: MODELS.stateviz,
        max_tokens: 4000,
        system,
        messages,
        user: userId // token-usage attribution
    });
    if (onText) {
        stream.on('text', onText);
    }

    const message = await stream.finalMessage();
    return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
}
