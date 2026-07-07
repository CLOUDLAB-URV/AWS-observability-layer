'use strict';

// Persistence for internal login: users and sessions, stored under the same persistence/ tree as
// the rest of the app (mounted as a Docker volume in the deploy, so it survives container
// recreation). File-based, mirroring tokenStore.js.
//
// Layout:
//   persistence/users.json          → { [userId]: { email, emailLower, username, usernameLower,
//                                        passwordHash, verified, createdAt, code|null,
//                                        role?: 'admin', lastLogin?: ISO } }
//   persistence/sessions/<sid>.json → { userId, createdAt, expiresAt }
//
// Auth is email + username + password with an email verification CODE. Passwords are scrypt-hashed;
// codes are short-lived, sha256-hashed, attempt-limited. `userId` (usr_<hex>) stays opaque so the
// rest of the codebase (visualizerStore, tokenStore) is unaffected.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomBytes, randomInt, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Defaults to the app's persistence/ tree. AUTH_PERSIST_DIR overrides it so tests can point at an
// isolated temp directory instead of touching real data (never set in production).
const PERSIST = process.env.AUTH_PERSIST_DIR
    ? path.resolve(process.env.AUTH_PERSIST_DIR)
    : path.join(__dirname, 'persistence');
const USERS_FILE = path.join(PERSIST, 'users.json');
const SESSIONS_DIR = path.join(PERSIST, 'sessions');

// Exposed so the operator CLI (scripts/admin-cli.js) writes its audit log next to users.json —
// same resolution, zero drift with whatever the running server uses.
export const persistDir = PERSIST;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const CODE_TTL_MS = 10 * 60 * 1000;                // verification code lifetime: 10 min
const CODE_MAX_ATTEMPTS = 5;                       // wrong tries before a code is burned
const RESEND_COOLDOWN_MS = 30 * 1000;              // min gap between code sends
const RESET_TTL_MS = 30 * 60 * 1000;               // password-reset link lifetime: 30 min

function maxUsers() {
    const n = Number.parseInt(process.env.MAX_USERS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

// --- password hashing (scrypt, no deps) ---------------------------------------------------
export function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(String(password), salt, 32);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
        return false;
    }
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const got = scryptSync(String(password), salt, expected.length);
    return got.length === expected.length && timingSafeEqual(got, expected);
}

// --- verification codes (6 digits, stored hashed) -----------------------------------------
function newCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
function hashCode(code) {
    return createHash('sha256').update(String(code)).digest('hex');
}
function freshCodeRecord(code) {
    return { hash: hashCode(code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() };
}

// --- file io (serialized writes) ----------------------------------------------------------
let writeQueue = Promise.resolve();
function enqueue(task) {
    const next = writeQueue.then(task, task);
    writeQueue = next.catch(() => {});
    return next;
}

async function readUsers() {
    try {
        const parsed = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function writeUsers(map) {
    await fs.mkdir(PERSIST, { recursive: true });
    // Atomic write (tmp + rename): request handlers read this file outside the
    // write queue, so a plain writeFile could hand them a truncated JSON mid-write
    // (seen as intermittent 401s under concurrent sign-ups).
    const tmp = `${USERS_FILE}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, USERS_FILE);
}

// Role is stored only when it is 'admin' (revoking deletes the key), so any other/missing/garbage
// value degrades safely to 'user'. Admin is granted exclusively via the operator CLI
// (scripts/admin-cli.js) — there is no HTTP path that mutates it.
function roleOf(rec) {
    return rec.role === 'admin' ? 'admin' : 'user';
}

function publicUser(userId, rec) {
    return { userId, email: rec.email, username: rec.username, name: rec.username, role: roleOf(rec) };
}

export async function countUsers() {
    return Object.keys(await readUsers()).length;
}

// Full account listing for the admin panel / operator CLI. Read-only projection: public shape
// plus the account metadata an admin needs (never the password hash or pending codes/tokens).
export async function listUsers() {
    const map = await readUsers();
    return Object.entries(map)
        .map(([userId, rec]) => ({
            ...publicUser(userId, rec),
            verified: Boolean(rec.verified),
            createdAt: rec.createdAt || null,
            lastLogin: rec.lastLogin || null
        }))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Account/usage summary for the admin panel header ("N of M accounts") and the CLI `stats` command.
export async function usageStats() {
    const map = await readUsers();
    const recs = Object.values(map);
    return {
        totalCount: recs.length,
        verifiedCount: recs.filter((r) => r.verified).length,
        adminCount: recs.filter((r) => roleOf(r) === 'admin').length,
        maxUsers: maxUsers()
    };
}

export async function getUser(userId) {
    const rec = (await readUsers())[userId];
    return rec ? publicUser(userId, rec) : null;
}

function findIdBy(map, field, value) {
    const v = String(value ?? '').trim().toLowerCase();
    return Object.keys(map).find((uid) => map[uid][field] === v);
}

// Create (or refresh) a pending, unverified user and return a one-time code to email.
// Returns { userId, code } on success, or { error } where error is:
//   'email_taken' | 'username_taken' (by a VERIFIED user) | 'limit' (MAX_USERS reached).
export function createPendingUser({ email, username, password }) {
    return enqueue(async () => {
        const map = await readUsers();
        const emailLower = String(email).trim().toLowerCase();
        const usernameLower = String(username).trim().toLowerCase();

        const emailId = findIdBy(map, 'emailLower', emailLower);
        const usernameId = findIdBy(map, 'usernameLower', usernameLower);

        // Block only against VERIFIED accounts; an unverified one can be re-registered.
        if (emailId && map[emailId].verified) {
            return { error: 'email_taken' };
        }
        if (usernameId && map[usernameId].verified && usernameId !== emailId) {
            return { error: 'username_taken' };
        }

        // Reuse the pending record for this email if it exists, else mint a new id.
        const userId = (emailId && !map[emailId].verified) ? emailId : `usr_${randomBytes(8).toString('hex')}`;

        // Enforce the cap only when adding a genuinely new account.
        if (!map[userId] && Object.keys(map).length >= maxUsers()) {
            return { error: 'limit' };
        }

        const code = newCode();
        map[userId] = {
            email: String(email).trim(),
            emailLower,
            username: String(username).trim(),
            usernameLower,
            passwordHash: hashPassword(password),
            verified: false,
            createdAt: map[userId]?.createdAt || new Date().toISOString(),
            code: freshCodeRecord(code)
        };
        await writeUsers(map);
        return { userId, code };
    });
}

// Issue a fresh code for a pending user (resend). Returns { code } or { error:'not_found'
// |'already_verified'|'cooldown' }.
export function resendCode(email) {
    return enqueue(async () => {
        const map = await readUsers();
        const id = findIdBy(map, 'emailLower', email);
        if (!id) {
            return { error: 'not_found' };
        }
        if (map[id].verified) {
            return { error: 'already_verified' };
        }
        if (map[id].code && Date.now() - (map[id].code.sentAt || 0) < RESEND_COOLDOWN_MS) {
            return { error: 'cooldown' };
        }
        const code = newCode();
        map[id].code = freshCodeRecord(code);
        await writeUsers(map);
        return { code };
    });
}

// Verify an email's code. Returns { user } on success, or { error:'not_found'|'no_code'|
// 'expired'|'too_many'|'bad_code' }.
export function verifyEmailCode(email, code) {
    return enqueue(async () => {
        const map = await readUsers();
        const id = findIdBy(map, 'emailLower', email);
        if (!id) {
            return { error: 'not_found' };
        }
        const rec = map[id];
        if (rec.verified) {
            return { user: publicUser(id, rec) };
        }
        if (!rec.code) {
            return { error: 'no_code' };
        }
        if (Date.now() > rec.code.expiresAt) {
            return { error: 'expired' };
        }
        if (rec.code.attempts >= CODE_MAX_ATTEMPTS) {
            return { error: 'too_many' };
        }
        const ok = hashCode(code) === rec.code.hash;
        if (!ok) {
            rec.code.attempts += 1;
            await writeUsers(map);
            return { error: 'bad_code' };
        }
        rec.verified = true;
        rec.code = null;
        await writeUsers(map);
        return { user: publicUser(id, rec) };
    });
}

// Check login credentials (email OR username + password). Returns { user }, or
// { error:'bad_creds' } (generic), or { error:'unverified', email } when correct but not verified.
export async function verifyLogin(identifier, password) {
    const map = await readUsers();
    const key = String(identifier ?? '').trim().toLowerCase();
    const id = findIdBy(map, 'emailLower', key) || findIdBy(map, 'usernameLower', key);
    if (!id || !verifyPassword(password, map[id].passwordHash)) {
        return { error: 'bad_creds' };
    }
    if (!map[id].verified) {
        return { error: 'unverified', email: map[id].email };
    }
    return { user: publicUser(id, map[id]) };
}

// --- account management -------------------------------------------------------------------
// Change a logged-in user's password. Verifies the current one first. Returns { ok } or
// { error:'not_found'|'bad_current' }.
export function changePassword(userId, currentPassword, newPassword) {
    return enqueue(async () => {
        const map = await readUsers();
        const rec = map[userId];
        if (!rec) {
            return { error: 'not_found' };
        }
        if (!verifyPassword(currentPassword, rec.passwordHash)) {
            return { error: 'bad_current' };
        }
        rec.passwordHash = hashPassword(newPassword);
        await writeUsers(map);
        return { ok: true };
    });
}

// Grant or revoke the admin role. Identifier is an email OR username (same dual lookup as
// verifyLogin). Only ever called by the operator CLI — never exposed over HTTP. Revoking deletes
// the role key so records stay clean. Returns { ok, user, previousRole } or
// { error:'not_found'|'bad_role' }.
export function setRole(identifier, role) {
    return enqueue(async () => {
        if (role !== 'admin' && role !== 'user') {
            return { error: 'bad_role' };
        }
        const map = await readUsers();
        const key = String(identifier ?? '').trim().toLowerCase();
        const id = findIdBy(map, 'emailLower', key) || findIdBy(map, 'usernameLower', key);
        if (!id) {
            return { error: 'not_found' };
        }
        const previousRole = roleOf(map[id]);
        if (role === 'admin') {
            map[id].role = 'admin';
        } else {
            delete map[id].role;
        }
        await writeUsers(map);
        return { ok: true, user: publicUser(id, map[id]), previousRole };
    });
}

// Stamp the account's last login time. Called fire-and-forget when a session is created — a
// failed write must never break the login itself.
export function touchLastLogin(userId) {
    return enqueue(async () => {
        const map = await readUsers();
        if (!map[userId]) {
            return;
        }
        map[userId].lastLogin = new Date().toISOString();
        await writeUsers(map);
    });
}

// Permanently remove a user record. Returns { ok, user } (public shape, for logging) or
// { error:'not_found' }. Callers are responsible for wiping the user's other data (tokens,
// diagrams, sessions).
export function deleteUser(userId) {
    return enqueue(async () => {
        const map = await readUsers();
        const rec = map[userId];
        if (!rec) {
            return { error: 'not_found' };
        }
        const user = publicUser(userId, rec);
        delete map[userId];
        await writeUsers(map);
        return { ok: true, user };
    });
}

// --- password reset (link-based, single-use token) ----------------------------------------
function freshResetRecord(token) {
    return { hash: hashCode(token), expiresAt: Date.now() + RESET_TTL_MS };
}

// Issue a one-time reset token for a VERIFIED account. Returns { token, username, email } or
// { error:'not_found'|'unverified' }. The route should respond identically either way
// (anti-enumeration) — the error is only for deciding whether to send the email.
export function createResetToken(email) {
    return enqueue(async () => {
        const map = await readUsers();
        const id = findIdBy(map, 'emailLower', email);
        if (!id) {
            return { error: 'not_found' };
        }
        if (!map[id].verified) {
            return { error: 'unverified' };
        }
        const token = randomBytes(32).toString('hex');
        map[id].reset = freshResetRecord(token);
        await writeUsers(map);
        return { token, username: map[id].username, email: map[id].email };
    });
}

// Consume a reset token and set a new password. Returns { ok, user } or
// { error:'invalid'|'expired' }. Single-use: the token is cleared on success.
export function consumeResetToken(token, newPassword) {
    return enqueue(async () => {
        const map = await readUsers();
        const hash = hashCode(String(token ?? ''));
        const id = Object.keys(map).find((uid) => map[uid].reset && map[uid].reset.hash === hash);
        if (!id) {
            return { error: 'invalid' };
        }
        if (Date.now() > map[id].reset.expiresAt) {
            delete map[id].reset;
            await writeUsers(map);
            return { error: 'expired' };
        }
        map[id].passwordHash = hashPassword(newPassword);
        delete map[id].reset;
        await writeUsers(map);
        return { ok: true, user: publicUser(id, map[id]) };
    });
}

// --- sessions -----------------------------------------------------------------------------
export async function createSession(userId) {
    const sid = randomBytes(24).toString('hex');
    const now = Date.now();
    const record = { userId, createdAt: new Date(now).toISOString(), expiresAt: now + SESSION_TTL_MS };
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(path.join(SESSIONS_DIR, `${sid}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return sid;
}

export async function getSessionUser(sid) {
    const id = String(sid ?? '').trim();
    if (!id || !/^[a-f0-9]{48}$/.test(id)) {
        return null;
    }
    let record;
    try {
        record = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
    } catch {
        return null;
    }
    if (!record || typeof record.expiresAt !== 'number' || record.expiresAt < Date.now()) {
        await deleteSession(id);
        return null;
    }
    return getUser(record.userId);
}

export async function deleteSession(sid) {
    const id = String(sid ?? '').trim();
    if (!id || !/^[a-f0-9]{48}$/.test(id)) {
        return;
    }
    try {
        await fs.unlink(path.join(SESSIONS_DIR, `${id}.json`));
    } catch {
        // already gone
    }
}

// Delete every session belonging to a user (used when the account is removed so all devices are
// logged out). Best-effort: missing files / unreadable records are skipped.
export async function deleteAllSessionsForUser(userId) {
    let files;
    try {
        files = await fs.readdir(SESSIONS_DIR);
    } catch {
        return;
    }
    await Promise.all(files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
            try {
                const record = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
                if (record && record.userId === userId) {
                    await fs.unlink(path.join(SESSIONS_DIR, f)).catch(() => {});
                }
            } catch {
                // unreadable / already gone
            }
        }));
}
