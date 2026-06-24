'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new Map();

// Loads a prompt file co-located with the calling agent. Pass `import.meta.url`
// so the path resolves relative to that agent's own folder.
export async function loadPrompt(metaUrl, file = 'prompt.md') {
    const filePath = path.join(path.dirname(fileURLToPath(metaUrl)), file);
    if (!cache.has(filePath)) {
        cache.set(filePath, await fs.readFile(filePath, 'utf8'));
    }
    return cache.get(filePath);
}

// Substitutes [TOKEN] placeholders in a template with the provided values.
export function fill(template, vars) {
    let out = template;
    for (const [key, value] of Object.entries(vars)) {
        out = out.split(`[${key}]`).join(value);
    }
    return out;
}
