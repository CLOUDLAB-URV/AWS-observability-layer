'use strict';

// Minimal API-token store for the "Deployed state" feature. The distributable MCP
// tool authenticates its uploads with a Bearer token the user generates in the web
// UI; this maps token → { userId, label, createdAt }.
//
// Identity model: every credential resolves to a REAL userId. A logged-in user
// generates tokens that map to their own userId; with auth off (local dev) the
// single "dev" user is the persisted owner (persistence/owner.json). There is no
// shared env token — the only way to authenticate is a token generated in the UI,
// so every token is tied to the user who created it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, 'persistence', 'tokens.json');
const OWNER_FILE = path.join(__dirname, 'persistence', 'owner.json');

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
    const map = await readAll();
    const entry = map[t];
    return entry ? { userId: entry.userId, label: entry.label } : null;
}

export function create(userId, label = '') {
    const token = `viz_${randomBytes(24).toString('hex')}`;
    return enqueue(async () => {
        const owner = userId || (await getOwnerUserId());
        const map = await readAll();
        map[token] = { userId: owner, label: String(label || ''), createdAt: new Date().toISOString() };
        await writeAll(map);
        return { token, userId: owner, label };
    });
}

export async function list(userId) {
    const owner = userId || (await getOwnerUserId());
    const map = await readAll();
    const out = Object.entries(map)
        .filter(([, v]) => v.userId === owner)
        .map(([token, v]) => ({
            // Never return the full secret to the UI; show a masked preview only.
            tokenPreview: `${token.slice(0, 8)}…${token.slice(-4)}`,
            label: v.label,
            createdAt: v.createdAt
        }));
    return out;
}

export function revoke(token) {
    return enqueue(async () => {
        const map = await readAll();
        const existed = Boolean(map[token]);
        delete map[token];
        await writeAll(map);
        return existed;
    });
}
