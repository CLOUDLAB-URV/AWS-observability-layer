'use strict';

// Minimal API-token store for the "Deployed state" feature. The distributable MCP
// tool authenticates its uploads with a Bearer token the user generates in the web
// UI; this maps token → { userId, label, createdAt }.
//
// v1 is single-user: if VISUALIZER_TOKEN is set in the environment it is always
// accepted (seeded user "local"), so the feature works out of the box without any
// token-management UI. Generated tokens are persisted to data/tokens.json. The
// API (verify/create/list/revoke) is shaped so phase 2 can swap in real accounts
// without changing call sites.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, 'data', 'tokens.json');

const ENV_TOKEN = process.env.VISUALIZER_TOKEN || '';
const LOCAL_USER = 'local';

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

// Returns { userId, label } for a valid token, or null. The env token (if set) is
// always valid and maps to the local user — the zero-config path for v1.
export async function verify(token) {
    const t = String(token ?? '').trim();
    if (!t) {
        return null;
    }
    if (ENV_TOKEN && t === ENV_TOKEN) {
        return { userId: LOCAL_USER, label: 'env' };
    }
    const map = await readAll();
    const entry = map[t];
    return entry ? { userId: entry.userId, label: entry.label } : null;
}

export function create(userId = LOCAL_USER, label = '') {
    const token = `viz_${randomBytes(24).toString('hex')}`;
    return enqueue(async () => {
        const map = await readAll();
        map[token] = { userId, label: String(label || ''), createdAt: new Date().toISOString() };
        await writeAll(map);
        return { token, userId, label };
    });
}

export async function list(userId = LOCAL_USER) {
    const map = await readAll();
    const out = Object.entries(map)
        .filter(([, v]) => v.userId === userId)
        .map(([token, v]) => ({
            // Never return the full secret to the UI; show a masked preview only.
            tokenPreview: `${token.slice(0, 8)}…${token.slice(-4)}`,
            label: v.label,
            createdAt: v.createdAt
        }));
    if (ENV_TOKEN && userId === LOCAL_USER) {
        out.unshift({ tokenPreview: 'env (VISUALIZER_TOKEN)', label: 'env', createdAt: null });
    }
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
