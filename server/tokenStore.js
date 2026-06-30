'use strict';

// Minimal API-token store for the "Deployed state" feature. The distributable MCP
// tool authenticates its uploads with a Bearer token the user generates in the web
// UI; this maps token → { id, userId, label, createdAt }.
//
// Identity model: every credential resolves to a REAL userId. In production a logged-in user
// generates tokens (stored here) that map to their own userId. In local dev there is NO generated
// store: auth is off, generation is disabled, and the only valid token is the fixed env-var one
// (DEV_VISUALIZER_TOKEN) which maps to the single fixed dev user (see persistence.js) — so the MCP
// works out of the box with nothing persisted.
//
// The full token secret is only ever returned once (at create time); afterwards the
// UI only sees a masked preview and a non-secret `id` it can use to revoke. Each user
// may hold at most MAX_TOKENS_PER_USER tokens.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistRoot, DEV, DEV_USER_ID, DEV_TOKEN } from './persistence.js';

const TOKENS_FILE = path.join(persistRoot(), 'tokens.json');
const OWNER_FILE = path.join(persistRoot(), 'owner.json');

// Max API tokens a single user may hold at once.
export const MAX_TOKENS_PER_USER = 3;

// The owner userId is created once and persisted, then reused for every credential
// on this machine. Cached in-process after the first resolve.
let ownerUserId = null;

export async function getOwnerUserId() {
    if (ownerUserId) {
        return ownerUserId;
    }
    try {
        const parsed = JSON.parse(await fs.readFile(OWNER_FILE, 'utf8'));
        if (parsed && typeof parsed.userId === 'string' && parsed.userId) {
            ownerUserId = parsed.userId;
            return ownerUserId;
        }
    } catch {
        // No owner yet — fall through and mint one.
    }
    ownerUserId = `usr_${randomBytes(8).toString('hex')}`;
    await fs.mkdir(path.dirname(OWNER_FILE), { recursive: true });
    await fs.writeFile(OWNER_FILE, `${JSON.stringify({ userId: ownerUserId }, null, 2)}\n`, 'utf8');
    return ownerUserId;
}

let writeQueue = Promise.resolve();
function enqueue(task) {
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
}

async function readAll() {
    try {
        const parsed = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function writeAll(map) {
    await fs.mkdir(path.dirname(TOKENS_FILE), { recursive: true });
    await fs.writeFile(TOKENS_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

// Returns { userId, label } for a valid token, or null. Tokens are only ever the
// ones generated in the web UI; there is no shared env token.
export async function verify(token) {
    const t = String(token ?? '').trim();
    if (!t) {
        return null;
    }
    // Local dev: the only valid token is the fixed env-var one, mapped to the fixed dev user.
    // There is no generated-token store in dev (generation is disabled), so don't read the file.
    if (DEV) {
        return t === DEV_TOKEN ? { userId: DEV_USER_ID, label: 'local dev (env)' } : null;
    }
    const map = await readAll();
    const entry = map[t];
    return entry ? { userId: entry.userId, label: entry.label } : null;
}

// How many tokens a user currently holds.
export async function countForUser(userId) {
    const map = await readAll();
    return Object.values(map).filter((v) => v.userId === userId).length;
}

// Create a token for the user, unless they're already at the cap. Returns
// { token, id } on success, or { error: 'limit', max } when the cap is reached.
// The full `token` is the only time the secret is exposed.
export function create(userId, label = '') {
    if (DEV) {
        // No generated tokens in local dev — the MCP uses the fixed DEV_VISUALIZER_TOKEN.
        return Promise.resolve({ error: 'dev_disabled' });
    }
    return enqueue(async () => {
        const owner = userId || (await getOwnerUserId());
        const map = await readAll();
        const count = Object.values(map).filter((v) => v.userId === owner).length;
        if (count >= MAX_TOKENS_PER_USER) {
            return { error: 'limit', max: MAX_TOKENS_PER_USER };
        }
        const token = `viz_${randomBytes(24).toString('hex')}`;
        const id = `tok_${randomBytes(8).toString('hex')}`;
        map[token] = { id, userId: owner, label: String(label || ''), createdAt: new Date().toISOString() };
        await writeAll(map);
        return { token, id, userId: owner, label };
    });
}

export async function list(userId) {
    const owner = userId || (await getOwnerUserId());
    const map = await readAll();
    const out = Object.entries(map)
        .filter(([, v]) => v.userId === owner)
        .map(([token, v]) => ({
            id: v.id || '',
            // Never return the full secret to the UI; show a masked preview only.
            tokenPreview: `${token.slice(0, 8)}…${token.slice(-4)}`,
            label: v.label,
            createdAt: v.createdAt
        }))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return out;
}

// Revoke a token by its non-secret id, scoped to the owner so a user can only ever
// delete their own tokens. Returns true if one was removed.
export function revoke(userId, id) {
    if (DEV) {
        return Promise.resolve(false);
    }
    return enqueue(async () => {
        const map = await readAll();
        const entry = Object.entries(map).find(([, v]) => v.userId === userId && v.id === id);
        if (!entry) {
            return false;
        }
        delete map[entry[0]];
        await writeAll(map);
        return true;
    });
}

// Revoke every token owned by a user (used when the account is deleted). Returns the count
// removed.
export function revokeAllForUser(userId) {
    return enqueue(async () => {
        const map = await readAll();
        const tokens = Object.entries(map).filter(([, v]) => v.userId === userId).map(([t]) => t);
        for (const t of tokens) {
            delete map[t];
        }
        if (tokens.length) {
            await writeAll(map);
        }
        return tokens.length;
    });
}
