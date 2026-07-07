'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated tests for the admin-configurable settings store. PERSIST_DIR points the
// store (via persistence.js) at a temp directory; imported dynamically AFTER the
// env is set because persistRoot() caches its resolution on first use.

let tmp;
let store;

before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-test-'));
    process.env.PERSIST_DIR = tmp;
    delete process.env.MAX_USERS;
    delete process.env.MAX_SIGILS_PER_USER;
    process.env.MAX_TOKENS_PER_USER = '5'; // env default for one key
    store = await import('./settingsStore.js');
});

after(async () => {
    delete process.env.MAX_TOKENS_PER_USER;
    await fs.rm(tmp, { recursive: true, force: true });
});

test('precedence: built-in default < env var < admin override', async () => {
    // No env, no override → built-in defaults.
    assert.equal(await store.getSetting('maxUsers'), 30);
    assert.equal(await store.getSetting('maxSigilsPerUser'), 20);
    // Env set → env wins over built-in.
    assert.equal(await store.getSetting('maxTokensPerUser'), 5);

    // Admin override wins over both.
    assert.deepEqual(await store.setSettings({ maxTokensPerUser: 9, maxUsers: 100 }), { ok: true });
    assert.equal(await store.getSetting('maxTokensPerUser'), 9);
    assert.equal(await store.getSetting('maxUsers'), 100);

    const all = await store.getAllSettings();
    assert.equal(all.maxUsers.source, 'admin');
    assert.equal(all.maxTokensPerUser.source, 'admin');
    assert.equal(all.maxTokensPerUser.default, 5); // what it falls back to on reset
    assert.equal(all.maxSigilsPerUser.source, 'default');
});

test('null removes an override and falls back to env/default', async () => {
    await store.setSettings({ maxTokensPerUser: null, maxUsers: null });
    assert.equal(await store.getSetting('maxTokensPerUser'), 5);   // env
    assert.equal(await store.getSetting('maxUsers'), 30);          // built-in
    const all = await store.getAllSettings();
    assert.equal(all.maxTokensPerUser.source, 'env');
    assert.equal(all.maxUsers.source, 'default');
});

test('validation: unknown keys and out-of-range values are rejected', async () => {
    assert.match((await store.setSettings({ bogusKey: 5 })).error, /Unknown setting/);
    assert.match((await store.setSettings({ maxUsers: 0 })).error, /between 1 and/);
    assert.match((await store.setSettings({ maxUsers: -3 })).error, /between 1 and/);
    assert.match((await store.setSettings({ maxUsers: 999999 })).error, /between 1 and/);
    assert.match((await store.setSettings({ maxUsers: 'lots' })).error, /between 1 and/);
    // A failed patch must not partially apply.
    assert.equal(await store.getSetting('maxUsers'), 30);
});

test('overrides persist on disk (settings.json in the persist root)', async () => {
    await store.setSettings({ maxSigilsPerUser: 7 });
    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'settings.json'), 'utf8'));
    assert.equal(raw.maxSigilsPerUser, 7);
    assert.equal(await store.getSetting('maxSigilsPerUser'), 7);
});
