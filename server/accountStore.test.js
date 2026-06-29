'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated file-IO tests for the account-management store functions (change password, password
// reset, delete user, session cleanup). AUTH_PERSIST_DIR points the store at a temp directory so
// the real persistence/ tree is never touched. The store is imported dynamically AFTER the env is
// set, because the module resolves its persistence path at load time.

let tmp;
let store;

before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'authstore-test-'));
    process.env.AUTH_PERSIST_DIR = tmp;
    process.env.MAX_USERS = '10';
    store = await import('./authStore.js');
});

after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
});

// Helper: create a verified user and return its id.
async function makeVerifiedUser({ email, username, password }) {
    const created = await store.createPendingUser({ email, username, password });
    assert.ok(created.userId, 'pending user created');
    const verified = await store.verifyEmailCode(email, created.code);
    assert.ok(verified.user, 'user verified');
    return verified.user.userId;
}

test('changePassword requires the correct current password', async () => {
    const userId = await makeVerifiedUser({
        email: 'cp@example.com', username: 'cpuser', password: 'oldpassword1'
    });

    const wrong = await store.changePassword(userId, 'nope', 'newpassword1');
    assert.equal(wrong.error, 'bad_current');

    const ok = await store.changePassword(userId, 'oldpassword1', 'newpassword1');
    assert.equal(ok.ok, true);

    // Old password no longer works; the new one does.
    assert.equal((await store.verifyLogin('cpuser', 'oldpassword1')).error, 'bad_creds');
    assert.equal((await store.verifyLogin('cpuser', 'newpassword1')).user?.username, 'cpuser');
});

test('password reset token sets a new password and is single-use', async () => {
    await makeVerifiedUser({ email: 'rs@example.com', username: 'rsuser', password: 'origpass123' });

    const { token } = await store.createResetToken('rs@example.com');
    assert.ok(token, 'reset token issued');

    const done = await store.consumeResetToken(token, 'brandnew123');
    assert.equal(done.ok, true);
    assert.equal((await store.verifyLogin('rsuser', 'brandnew123')).user?.username, 'rsuser');

    // Re-using the same token fails (cleared on success).
    assert.equal((await store.consumeResetToken(token, 'whatever123')).error, 'invalid');
    // A garbage token is invalid too.
    assert.equal((await store.consumeResetToken('deadbeef', 'whatever123')).error, 'invalid');
});

test('createResetToken does not issue for unknown or unverified emails', async () => {
    assert.equal((await store.createResetToken('nobody@example.com')).error, 'not_found');

    await store.createPendingUser({ email: 'pending@example.com', username: 'pendinguser', password: 'pendingpass1' });
    assert.equal((await store.createResetToken('pending@example.com')).error, 'unverified');
});

test('deleteUser removes the account and its sessions', async () => {
    const userId = await makeVerifiedUser({
        email: 'del@example.com', username: 'deluser', password: 'deletepass1'
    });
    const sid = await store.createSession(userId);
    assert.ok(await store.getSessionUser(sid), 'session resolves before delete');

    await store.deleteAllSessionsForUser(userId);
    assert.equal(await store.getSessionUser(sid), null, 'sessions wiped');

    const deleted = await store.deleteUser(userId);
    assert.equal(deleted.ok, true);
    assert.equal(await store.getUser(userId), null, 'user gone');
    assert.equal((await store.deleteUser(userId)).error, 'not_found');
});
