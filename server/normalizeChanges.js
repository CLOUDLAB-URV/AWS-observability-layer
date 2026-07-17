'use strict';

// Pure normalization of the incremental changes the MCP tool uploads, kept out of index.js
// so it can be unit-tested without booting the server.

// A resource's `code` (Lambda handler, EC2 user-data, etc.) is stored verbatim and shown
// in the web, but state.json is loaded whole and (compacted) fed to the LLM, so an unbounded
// paste would bloat storage and the token bill. Cap the content per file and the file count.
export const MAX_CODE_CHARS = 20000;
export const MAX_CODE_FILES = 12;

// Coerce and cap the per-resource `code` array. Returns a trimmed array or undefined (so the
// caller can drop the key entirely when there is nothing usable).
export function normalizeCode(code) {
    if (!Array.isArray(code)) {
        return undefined;
    }
    const files = [];
    for (const entry of code) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const name = String(entry.name ?? '').trim().slice(0, 200);
        const content = typeof entry.content === 'string' ? entry.content.slice(0, MAX_CODE_CHARS) : '';
        if (!name || !content) {
            continue;
        }
        const file = { name, content };
        const language = String(entry.language ?? '').trim().slice(0, 40);
        if (language) {
            file.language = language;
        }
        files.push(file);
        if (files.length >= MAX_CODE_FILES) {
            break;
        }
    }
    return files.length ? files : undefined;
}

// Normalize the incremental changes the MCP tool uploaded into the canonical shape
// the state-merge pipeline expects: `{ op, type, id, ...resourceFields }`. Each
// change must carry a `type` and a stable `id` (the key it merges under); `op`
// defaults to 'upsert'. Entries missing type+id, or with an unknown op, are dropped.
export function normalizeChanges(body) {
    if (!Array.isArray(body?.changes)) {
        return [];
    }
    return body.changes
        .map((change) => {
            if (!change || typeof change !== 'object') {
                return null;
            }
            const type = String(change.type ?? '').trim();
            const id = String(change.id ?? '').trim();
            if (!type || !id) {
                return null;
            }
            const op = change.op === 'delete' ? 'delete' : 'upsert';
            // Carry the whole detailed record through; only normalize the controls.
            const normalized = { ...change, op, type, id };
            // Per-resource deployment divergence: `deployed` must be a strict boolean (anything
            // else is dropped → inherits the sigil mode), `deploy_note` a short trimmed string.
            if (typeof change.deployed === 'boolean') {
                normalized.deployed = change.deployed;
            } else {
                delete normalized.deployed;
            }
            const note = typeof change.deploy_note === 'string' ? change.deploy_note.trim() : '';
            if (note) {
                normalized.deploy_note = note.slice(0, 300);
            } else {
                delete normalized.deploy_note;
            }
            // Source code the resource runs: capped and cleaned, or dropped if unusable.
            const code = normalizeCode(change.code);
            if (code) {
                normalized.code = code;
            } else {
                delete normalized.code;
            }
            return normalized;
        })
        .filter(Boolean);
}
