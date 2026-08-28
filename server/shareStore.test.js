'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The store resolves its file through persistRoot() at call time, so pointing PERSIST_DIR at a
// scratch directory BEFORE importing keeps these tests off the real persistence folder.
process.env.PERSIST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'sigilum-shares-'));
const shareStore = await import('./shareStore.js');

test('share: the same sigil always gets the same link', async () => {
    const first = await shareStore.create('usr_a', 'chat_1');
    const again = await shareStore.create('usr_a', 'chat_1');
    assert.equal(again.token, first.token, 'pressing Share twice must not mint a second link');
    assert.match(first.token, /^shr_[0-9a-f]{48}$/);
});

test('share: a token resolves to its sigil, and stops the moment it is revoked', async () => {
    const { token } = await shareStore.create('usr_b', 'chat_2');
    assert.deepEqual(await shareStore.verify(token), { userId: 'usr_b', chatId: 'chat_2', frozen: false });
    await shareStore.revoke('usr_b', 'chat_2');
    assert.equal(await shareStore.verify(token), null);
});

test('share: an unknown or empty token resolves to nothing', async () => {
    assert.equal(await shareStore.verify('shr_nope'), null);
    assert.equal(await shareStore.verify(''), null);
    assert.equal(await shareStore.verify(undefined), null);
});

test('share: freezing is one-way — a Live→Design→Live round trip never thaws it', async () => {
    const { token } = await shareStore.create('usr_c', 'chat_3');
    assert.equal(await shareStore.freeze('usr_c', 'chat_3'), true);
    const frozen = await shareStore.forSigil('usr_c', 'chat_3');
    assert.equal(frozen.frozen, true);
    // teardown_sigil puts the sigil back into Design, and it may be deployed again later. Neither
    // may move the line: by now its resources carry the real ARNs the agent reported from AWS.
    assert.equal(await shareStore.freeze('usr_c', 'chat_3'), false, 're-freezing is a no-op');
    assert.equal((await shareStore.forSigil('usr_c', 'chat_3')).frozen, true);
    assert.equal((await shareStore.verify(token)).frozen, true);
});

test('share: deleting an account takes every link it owned with it', async () => {
    await shareStore.create('usr_d', 'chat_4');
    const { token } = await shareStore.create('usr_d', 'chat_5');
    await shareStore.create('usr_e', 'chat_6');
    assert.equal(await shareStore.revokeAllForUser('usr_d'), 2);
    assert.equal(await shareStore.verify(token), null);
    assert.ok(await shareStore.forSigil('usr_e', 'chat_6'), 'another user keeps theirs');
});
