'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// visualizerStore resolves its storage root from persistRoot() at import time, so point
// PERSIST_DIR at an isolated temp dir BEFORE importing it (never touch the real persistence/).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vizstore-test-'));
process.env.PERSIST_DIR = tmp;
const store = await import('./visualizerStore.js');

const USER = 'usr_test';
const upsert = (id) => ({ op: 'upsert', type: 's3', id, name: id });

test('a new diagram defaults to Design (deployed:false)', async () => {
    await store.applyChanges(USER, 'design1', [upsert('a')]);
    const meta = await store.readMeta(USER, 'design1');
    assert.equal(meta.deployed, false);
});

test('deployed:true seeds a Live diagram, and later pushes preserve the flag', async () => {
    await store.applyChanges(USER, 'live1', [upsert('a')], undefined, true);
    assert.equal((await store.readMeta(USER, 'live1')).deployed, true);

    // A follow-up push without an explicit flag must NOT flip the mode.
    await store.applyChanges(USER, 'live1', [upsert('b')]);
    assert.equal((await store.readMeta(USER, 'live1')).deployed, true);
});

test('initialDeployed only seeds on creation, never flips an existing Design diagram', async () => {
    await store.applyChanges(USER, 'design2', [upsert('a')]); // created as Design
    await store.applyChanges(USER, 'design2', [upsert('b')], undefined, true); // late true ignored
    assert.equal((await store.readMeta(USER, 'design2')).deployed, false);
});

test('setDeployed transitions Design → Live and renameSession preserves the mode', async () => {
    await store.applyChanges(USER, 'design3', [upsert('a')]);
    await store.setDeployed(USER, 'design3', true);
    assert.equal((await store.readMeta(USER, 'design3')).deployed, true);

    const meta = await store.renameSession(USER, 'design3', 'My stack');
    assert.equal(meta.name, 'My stack');
    assert.equal(meta.deployed, true, 'rename must not drop the deployed flag');
});

test('listChats reports each diagram mode', async () => {
    const chats = await store.listChats(USER);
    const byId = Object.fromEntries(chats.map((c) => [c.chatId, c.deployed]));
    assert.equal(byId.design1, false);
    assert.equal(byId.live1, true);
    assert.equal(byId.design3, true);
});

test('upserts stamp per-resource deployed: inherited from the sigil mode by default', async () => {
    await store.applyChanges(USER, 'perres1', [upsert('a')]);                 // Design sigil
    await store.applyChanges(USER, 'perres2', [upsert('a')], undefined, true); // Live sigil
    const design = await store.readState(USER, 'perres1');
    const live = await store.readState(USER, 'perres2');
    assert.equal(design.a.deployed, false, 'Design resource inherits deployed:false');
    assert.equal(live.a.deployed, true, 'Live resource inherits deployed:true');
});

test('an explicit per-resource deployed divergence is stored verbatim with its note', async () => {
    await store.applyChanges(USER, 'perres3', [
        upsert('ok'),
        { ...upsert('failed'), deployed: false, deploy_note: 'create failed: AccessDenied' }
    ], undefined, true); // Live sigil with one failed resource
    const state = await store.readState(USER, 'perres3');
    assert.equal(state.ok.deployed, true);
    assert.equal(state.failed.deployed, false);
    assert.equal(state.failed.deploy_note, 'create failed: AccessDenied');
    assert.equal((await store.readMeta(USER, 'perres3')).deployed, true, 'sigil mode untouched');
});

test('a full-replace upsert clears a stale divergence and its note', async () => {
    await store.applyChanges(USER, 'perres4', [
        { ...upsert('a'), deployed: true, deploy_note: 'deployed early at user request' }
    ]); // Design sigil, one resource deployed early
    let state = await store.readState(USER, 'perres4');
    assert.equal(state.a.deployed, true);
    assert.equal(state.a.deploy_note, 'deployed early at user request');

    // Re-reporting the resource without the divergence fields resets it to the sigil mode.
    await store.applyChanges(USER, 'perres4', [upsert('a')]);
    state = await store.readState(USER, 'perres4');
    assert.equal(state.a.deployed, false, 'inherits Design mode again');
    assert.equal(state.a.deploy_note, undefined, 'stale note does not linger');
});

test('ask chat: empty by default, round-trips messages, clears with the sigil', async () => {
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), []);

    const at = new Date().toISOString();
    const messages = [
        { role: 'user', text: 'What is this?', at },
        { role: 'assistant', text: 'An S3 bucket.', at }
    ];
    await store.writeAskChat(USER, 'ask1', messages);
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), messages);

    await store.writeAskChat(USER, 'ask1', []); // the panel's Clear button
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), []);

    await store.deleteChat(USER, 'ask1');
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), []);
});

test('ask chat: history is capped to the most recent 50 messages', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${i}`,
        at: new Date().toISOString()
    }));
    await store.writeAskChat(USER, 'ask2', many);
    const saved = await store.readAskChat(USER, 'ask2');
    assert.equal(saved.length, 50);
    assert.equal(saved[0].text, 'msg 70', 'keeps the newest, drops the oldest');
    assert.equal(saved[49].text, 'msg 119');
});

test('nameConflict: detects a duplicate case/space-insensitively, ignoring the excepted chat', async () => {
    await store.applyChanges(USER, 'name-a', [upsert('a')]);
    await store.renameSession(USER, 'name-a', 'Order Pipeline');

    assert.equal(await store.nameConflict(USER, 'order   pipeline'), true, 'case/space-insensitive match');
    assert.equal(await store.nameConflict(USER, 'Something else'), false);
    // The diagram itself doesn't count as a conflict when it's excepted (renaming to same name).
    assert.equal(await store.nameConflict(USER, 'Order Pipeline', 'name-a'), false);
    // A DIFFERENT chat with that name does conflict.
    assert.equal(await store.nameConflict(USER, 'Order Pipeline', 'other-chat'), true);
});

test('uniqueName: returns the base when free, else appends the first free numeric suffix', async () => {
    await store.applyChanges(USER, 'uniq-1', [upsert('a')]);
    await store.renameSession(USER, 'uniq-1', 'Pipeline');
    await store.applyChanges(USER, 'uniq-2', [upsert('a')]);
    await store.renameSession(USER, 'uniq-2', 'Pipeline 2');

    assert.equal(await store.uniqueName(USER, 'Fresh name'), 'Fresh name', 'free name kept as-is');
    // "Pipeline" and "Pipeline 2" are taken → next free is "Pipeline 3".
    assert.equal(await store.uniqueName(USER, 'Pipeline'), 'Pipeline 3');
    // Excepting the holder lets it keep its own name.
    assert.equal(await store.uniqueName(USER, 'Pipeline', 'uniq-1'), 'Pipeline');
});

test.after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
});
