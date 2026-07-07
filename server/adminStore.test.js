'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated file-IO tests for the admin-role store functions (setRole, listUsers, usageStats,
// touchLastLogin) backing the admin panel and the operator CLI. AUTH_PERSIST_DIR points the
// store at a temp directory so the real persistence/ tree is never touched; imported dynamically
// AFTER the env is set (the module resolves its path at load time).

let tmp;
let store;

before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'adminstore-test-'));
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

test('users default to role user; setRole grants and revokes by email or username', async () => {
    const userId = await makeVerifiedUser({
        email: 'adm@example.com', username: 'admuser', password: 'password123'
    });
    const before1 = await store.getUser(userId);
    assert.equal(before1.role, 'user');

    // Grant by email (mixed case must resolve).
    const granted = await store.setRole('ADM@example.com', 'admin');
    assert.equal(granted.ok, true);
    assert.equal(granted.user.role, 'admin');
    assert.equal(granted.previousRole, 'user');
    assert.equal((await store.getUser(userId)).role, 'admin');

    // Revoke by username: role key is deleted, not stored as 'user'.
    const revoked = await store.setRole('admuser', 'user');
    assert.equal(revoked.ok, true);
    assert.equal(revoked.previousRole, 'admin');
    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'users.json'), 'utf8'));
    assert.equal('role' in raw[userId], false);
    assert.equal((await store.getUser(userId)).role, 'user');
});

test('setRole rejects unknown accounts and bad roles', async () => {
    assert.equal((await store.setRole('nobody@example.com', 'admin')).error, 'not_found');
    assert.equal((await store.setRole('adm@example.com', 'superuser')).error, 'bad_role');
});

test('listUsers projects account metadata without secrets', async () => {
    const users = await store.listUsers();
    assert.ok(users.length >= 1);
    const u = users.find((x) => x.username === 'admuser');
    assert.ok(u);
    assert.equal(u.role, 'user');
    assert.equal(u.verified, true);
    assert.ok(u.createdAt);
    assert.equal(u.lastLogin, null);
    assert.equal('passwordHash' in u, false);
    assert.equal('code' in u, false);
});

test('touchLastLogin stamps the record and flows through listUsers', async () => {
    const users = await store.listUsers();
    const u = users.find((x) => x.username === 'admuser');
    await store.touchLastLogin(u.userId);
    const updated = (await store.listUsers()).find((x) => x.userId === u.userId);
    assert.ok(updated.lastLogin, 'lastLogin stamped');
    assert.ok(Date.now() - new Date(updated.lastLogin).getTime() < 5000);
    // Unknown user is a safe no-op.
    await store.touchLastLogin('usr_doesnotexist');
});

test('usageStats counts totals, verified and admins against the cap', async () => {
    await store.setRole('admuser', 'admin');
    const stats = await store.usageStats();
    assert.equal(stats.maxUsers, 10);
    assert.ok(stats.totalCount >= 1);
    assert.ok(stats.verifiedCount >= 1);
    assert.equal(stats.adminCount, 1);
    await store.setRole('admuser', 'user');
});

test('setBan bans and unbans; ban blocks login and sessions; expiry self-clears', async () => {
    const userId = await makeVerifiedUser({
        email: 'banme@example.com', username: 'banme', password: 'password123'
    });
    const sid = await store.createSession(userId);
    assert.ok(await store.getSessionUser(sid), 'session works before the ban');

    // Ban for an hour: login rejected with the expiry, session cut, listUsers exposes it.
    const until = new Date(Date.now() + 3600_000).toISOString();
    const banned = await store.setBan(userId, until);
    assert.equal(banned.ok, true);
    assert.equal(banned.user.bannedUntil, until);
    const login = await store.verifyLogin('banme@example.com', 'password123');
    assert.equal(login.error, 'banned');
    assert.equal(login.until, until);
    assert.equal(await store.getSessionUser(sid), null, 'existing session is cut');
    assert.equal(await store.banStatus(userId), until);
    const listed = (await store.listUsers()).find((u) => u.userId === userId);
    assert.equal(listed.bannedUntil, until);

    // Unban restores access without re-login (the session file was never deleted).
    await store.setBan(userId, null);
    assert.ok(await store.getSessionUser(sid), 'session works again after unban');
    assert.equal(await store.banStatus(userId), null);
    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'users.json'), 'utf8'));
    assert.equal('bannedUntil' in raw[userId], false, 'unban deletes the key');

    // An already-expired ban is inert everywhere.
    await store.setBan(userId, new Date(Date.now() - 1000).toISOString());
    assert.ok((await store.verifyLogin('banme@example.com', 'password123')).user);
    assert.equal(await store.banStatus(userId), null);

    // Validation and unknown targets.
    assert.equal((await store.setBan(userId, 'not-a-date')).error, 'bad_until');
    assert.equal((await store.setBan('usr_nope', until)).error, 'not_found');
});
