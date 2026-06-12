'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, 'prompts');

const templateCache = new Map();

export async function loadTemplate(name) {
    if (!templateCache.has(name)) {
        templateCache.set(name, await fs.readFile(path.join(PROMPTS_DIR, `${name}.md`), 'utf8'));
    }
    return templateCache.get(name);
}

export async function buildStateMergePrompt(d2Content, queue) {
    const template = await loadTemplate('state-merge');
    return template
        .replace('[D2_CURRENT_STATE]', d2Content || '(empty diagram)')
        .replace('[AWS_COMMAND_QUEUE]', JSON.stringify(queue, null, 2));
}

export async function buildPreviewSystemPrompt(d2Content) {
    const template = await loadTemplate('preview');
    return template.replace('[D2_CURRENT_STATE]', d2Content || '(empty diagram)');
}
