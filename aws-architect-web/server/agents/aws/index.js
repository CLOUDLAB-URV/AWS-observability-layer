'use strict';

// AWS agent: agentic tool loop against a real AWS account via the MCP tools
// (Sonnet). Used for both deploy and deployed-mode changes. The system prompt
// (batching + pagination guidance) lives in prompt.md; the tools live in tools.js;
// the loop itself is the shared runner.

import { getGemini, MODELS } from '../shared/client.js';
import { loadPrompt, fill } from '../shared/prompt.js';
import { runToolLoop } from '../shared/toolLoop.js';
import { getAwsTools } from './tools.js';
import * as store from '../../projectStore.js';

export async function runAwsAgent(taskPrompt, emit) {
    const currentD2 = await store.readDiagram();
    const system = fill(await loadPrompt(import.meta.url), { CURRENT_D2_STATE: currentD2 || '(empty diagram)' });
    const tools = await getAwsTools();

    await runToolLoop({
        client: getGemini(),
        model: MODELS.aws,
        system,
        tools,
        messages: [{ role: 'user', content: taskPrompt }],
        emit
    });
}
