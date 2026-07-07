'use strict';

// Per-user LLM (Gemini) token accounting, persisted in <persistRoot>/llm-usage.json —
// the same durable volume as accounts and sigils. The adapter (agents/shared/client.js)
// records the SDK's usageMetadata after every call; the admin panel reads it, and the
// monthly per-user cap (settingsStore: maxLlmTokensPerUserPerMonth) is enforced against it.
//
// Buckets are calendar months (YYYY-MM), so the cap resets on the 1st. Calls with no user
// identity (Design mode's shared session) accrue under the "_design" pseudo-user — visible
// in totals, never capped.
//
// Shape: { [userId | "_design"]: { [YYYY-MM]: { input, output, total, calls } } }

import fs from 'node:fs/promises';
import path from 'node:path';
import { persistRoot } from './persistence.js';

const USAGE_FILE = () => path.join(persistRoot(), 'llm-usage.json');
const KEEP_MONTHS = 12;

export const DESIGN_USER = '_design';

let writeQueue = Promise.resolve();
function enqueue(task) {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => {});
    return next;
}

let cache = null;

async function readAll() {
    if (cache) {
        return cache;
    }
    try {
        const parsed = JSON.parse(await fs.readFile(USAGE_FILE(), 'utf8'));
        cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        cache = {};
    }
    return cache;
}

async function writeAll(map) {
    await fs.mkdir(persistRoot(), { recursive: true });
    const tmp = `${USAGE_FILE()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, USAGE_FILE());
    cache = map;
}

export function monthKey(date = new Date()) {
    return date.toISOString().slice(0, 7); // YYYY-MM
}

const toInt = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

// Cut-off key: months lexicographically below this are pruned on write.
function pruneCutoff() {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - KEEP_MONTHS);
    return monthKey(d);
}

// Accumulate one call's token usage. `userId` null/empty attributes to _design.
// Fire-and-forget from the adapter — never throws into the caller's path.
export function record(userId, { input = 0, output = 0, total = 0 } = {}) {
    return enqueue(async () => {
        const map = { ...(await readAll()) };
        const key = userId || DESIGN_USER;
        const month = monthKey();
        const months = { ...(map[key] ?? {}) };
        const bucket = { input: 0, output: 0, total: 0, calls: 0, ...(months[month] ?? {}) };
        bucket.input += toInt(input);
        bucket.output += toInt(output);
        bucket.total += toInt(total) || toInt(input) + toInt(output);
        bucket.calls += 1;
        months[month] = bucket;

        const cutoff = pruneCutoff();
        for (const m of Object.keys(months)) {
            if (m < cutoff) {
                delete months[m];
            }
        }
        map[key] = months;
        await writeAll(map);
    });
}

const EMPTY = Object.freeze({ input: 0, output: 0, total: 0, calls: 0 });

// Current-month usage for one user (zeros when none).
export async function monthUsage(userId) {
    const months = (await readAll())[userId || DESIGN_USER];
    return { ...EMPTY, ...(months?.[monthKey()] ?? {}) };
}

// Current-month usage for every user (including _design) + the grand total, for the panel.
export async function currentMonthByUser() {
    const map = await readAll();
    const month = monthKey();
    const byUser = {};
    const grandTotal = { ...EMPTY };
    for (const [key, months] of Object.entries(map)) {
        const bucket = months?.[month];
        if (!bucket) {
            continue;
        }
        byUser[key] = { ...EMPTY, ...bucket };
        grandTotal.input += byUser[key].input;
        grandTotal.output += byUser[key].output;
        grandTotal.total += byUser[key].total;
        grandTotal.calls += byUser[key].calls;
    }
    return { byUser, grandTotal };
}
