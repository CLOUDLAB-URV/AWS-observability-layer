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

test('changeUsername renames, enforces case-insensitive uniqueness and updates login', async () => {
    const userId = await makeVerifiedUser({
        email: 'rn@example.com', username: 'renameme', password: 'renamepass1'
    });
    await makeVerifiedUser({ email: 'other@example.com', username: 'takenname', password: 'otherpass1' });

    // Collision with another verified account, case-insensitively.
    assert.equal((await store.changeUsername(userId, 'TakenName')).error, 'username_taken');
    // Re-saving your own name (any case) is not a collision.
    assert.equal((await store.changeUsername(userId, 'RenameMe')).ok, true);

    const renamed = await store.changeUsername(userId, 'freshname');
    assert.equal(renamed.ok, true);
    assert.equal(renamed.user.username, 'freshname');

    // Login follows the rename: new name works, old one is free/no longer valid.
    assert.equal((await store.verifyLogin('freshname', 'renamepass1')).user?.userId, userId);
    assert.equal((await store.verifyLogin('renameme', 'renamepass1')).error, 'bad_creds');

    assert.equal((await store.changeUsername('usr_missing', 'whoever')).error, 'not_found');
});

test('setAvatar stores a data URL, clears with null, and shows in publicUser', async () => {
    const userId = await makeVerifiedUser({
        email: 'av@example.com', username: 'avataruser', password: 'avatarpass1'
    });
    assert.equal((await store.getUser(userId)).avatar, null);

    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const set = await store.setAvatar(userId, dataUrl);
    assert.equal(set.ok, true);
    assert.equal(set.user.avatar, dataUrl);
    assert.equal((await store.getUser(userId)).avatar, dataUrl);

    const cleared = await store.setAvatar(userId, null);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.user.avatar, null);

    assert.equal((await store.setAvatar('usr_missing', dataUrl)).error, 'not_found');
});

test('publicUser exposes createdAt and lastLogin', async () => {
    const userId = await makeVerifiedUser({
        email: 'meta@example.com', username: 'metauser', password: 'metapass123'
    });
    const before = await store.getUser(userId);
    assert.ok(before.createdAt, 'createdAt present');
    assert.equal(before.lastLogin, null);

    await store.touchLastLogin(userId);
    assert.ok((await store.getUser(userId)).lastLogin, 'lastLogin stamped');
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
