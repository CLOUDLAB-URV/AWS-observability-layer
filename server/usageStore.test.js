'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated tests for the per-user LLM token accounting. PERSIST_DIR points the
// store (via persistence.js) at a temp directory; imported dynamically AFTER the
// env is set because persistRoot() caches its resolution on first use.

let tmp;
let store;

before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
    process.env.PERSIST_DIR = tmp;
    // Pre-seed an ancient bucket BEFORE the store's first read (it caches in-process):
    // the first record() for usr_a must prune it (retention window is 12 months).
    await fs.writeFile(
        path.join(tmp, 'llm-usage.json'),
        JSON.stringify({ usr_a: { '2020-01': { input: 1, output: 1, total: 2, calls: 1 } } }),
        'utf8'
    );
    store = await import('./usageStore.js');
});

after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
});

test('record accumulates input/output/total/calls in the current month bucket', async () => {
    await store.record('usr_a', { input: 100, output: 50, total: 150 });
    await store.record('usr_a', { input: 10, output: 5, total: 15 });

    const usage = await store.monthUsage('usr_a');
    assert.deepEqual(usage, { input: 110, output: 55, total: 165, calls: 2 });

    // Persisted under the calendar-month key — and the pre-seeded 2020-01 bucket
    // (see before()) was pruned by the write, proving the retention window.
    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'llm-usage.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw.usr_a), [store.monthKey()]);
});

test('total falls back to input+output when the SDK omits totalTokenCount', async () => {
    await store.record('usr_b', { input: 20, output: 30 });
    assert.equal((await store.monthUsage('usr_b')).total, 50);
});

test('calls without a user accrue under the _design pseudo-user', async () => {
    await store.record(null, { input: 7, output: 3, total: 10 });
    await store.record('', { input: 1, output: 1, total: 2 });
    const usage = await store.monthUsage(store.DESIGN_USER);
    assert.deepEqual(usage, { input: 8, output: 4, total: 12, calls: 2 });
});

test('currentMonthByUser reports every user plus the grand total', async () => {
    const { byUser, grandTotal } = await store.currentMonthByUser();
    assert.equal(byUser.usr_a.total, 165);
    assert.equal(byUser[store.DESIGN_USER].total, 12);
    assert.equal(grandTotal.total, 165 + 50 + 12);
    assert.equal(grandTotal.calls, 5);
});

test('unknown user reads as zeros', async () => {
    assert.deepEqual(await store.monthUsage('usr_nobody'), { input: 0, output: 0, total: 0, calls: 0 });
});
