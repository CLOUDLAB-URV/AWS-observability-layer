'use strict';

// App-level runtime settings, editable from the admin panel and persisted in
// <persistRoot>/settings.json — the same durable volume as accounts and sigils,
// so admin overrides survive redeploys and migrate with the rest of the data.
//
// Resolution order per key: admin override (this file) > env var > built-in
// default. Env vars stay as the bootstrap defaults documented in .env.example;
// setting a key to null from the panel deletes the override and falls back.

import fs from 'node:fs/promises';
import path from 'node:path';
import { persistRoot } from './persistence.js';

const SETTINGS_FILE = () => path.join(persistRoot(), 'settings.json');

// key → { env: bootstrap env var, fallback: built-in default, max: sanity ceiling }
export const SETTING_DEFS = {
    maxUsers: { env: 'MAX_USERS', fallback: 30, max: 10000 },
    maxSigilsPerUser: { env: 'MAX_SIGILS_PER_USER', fallback: 20, max: 10000 },
    maxTokensPerUser: { env: 'MAX_TOKENS_PER_USER', fallback: 3, max: 100 },
    // LLM (Gemini) tokens each user may spend per calendar month (resets on the 1st).
    maxLlmTokensPerUserPerMonth: { env: 'MAX_LLM_TOKENS_PER_MONTH', fallback: 2_000_000, max: 1_000_000_000 }
};

let writeQueue = Promise.resolve();
function enqueue(task) {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => {});
    return next;
}

// In-process cache of the overrides map (single-process server); null = not
// loaded yet. Reads outside the queue are safe because writes are atomic.
let cache = null;

async function readOverrides() {
    if (cache) {
        return cache;
    }
    try {
        const parsed = JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8'));
        cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        cache = {};
    }
    return cache;
}

async function writeOverrides(map) {
    await fs.mkdir(persistRoot(), { recursive: true });
    // Atomic (tmp + rename): request handlers read this file concurrently.
    const tmp = `${SETTINGS_FILE()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, SETTINGS_FILE());
    cache = map;
}

function envValue(def) {
    const n = Number.parseInt(process.env[def.env] ?? '', 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, def.max) : null;
}

function validValue(def, raw) {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 && n <= def.max ? n : null;
}

// Effective value for one key (admin override > env > default).
export async function getSetting(key) {
    const def = SETTING_DEFS[key];
    if (!def) {
        throw new Error(`Unknown setting: ${key}`);
    }
    const overrides = await readOverrides();
    return validValue(def, overrides[key]) ?? envValue(def) ?? def.fallback;
}

// Full picture for the admin panel: effective value, where it comes from, and
// what it would fall back to if the override were removed.
export async function getAllSettings() {
    const overrides = await readOverrides();
    const out = {};
    for (const [key, def] of Object.entries(SETTING_DEFS)) {
        const override = validValue(def, overrides[key]);
        const env = envValue(def);
        out[key] = {
            value: override ?? env ?? def.fallback,
            source: override !== null ? 'admin' : env !== null ? 'env' : 'default',
            default: env ?? def.fallback,
            max: def.max
        };
    }
    return out;
}

// Apply a partial update from the panel. A key set to null removes the override
// (falls back to env/default); invalid keys or values return { error }.
export function setSettings(patch) {
    return enqueue(async () => {
        const map = { ...(await readOverrides()) };
        for (const [key, raw] of Object.entries(patch ?? {})) {
            const def = SETTING_DEFS[key];
            if (!def) {
                return { error: `Unknown setting: ${key}` };
            }
            if (raw === null) {
                delete map[key];
                continue;
            }
            const value = validValue(def, raw);
            if (value === null) {
                return { error: `${key} must be an integer between 1 and ${def.max}.` };
            }
            map[key] = value;
        }
        await writeOverrides(map);
        return { ok: true };
    });
}
