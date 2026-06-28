'use strict';

// Persistence for internal login: users and sessions, stored under the same persistence/ tree as
// the rest of the app (mounted as a Docker volume in the deploy, so it survives container
// recreation). File-based, mirroring tokenStore.js.
//
// Layout:
//   persistence/users.json          → { [userId]: { email, emailLower, username, usernameLower,
//                                        passwordHash, verified, createdAt, code|null } }
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
const PERSIST = path.join(__dirname, 'persistence');
const USERS_FILE = path.join(PERSIST, 'users.json');
const SESSIONS_DIR = path.join(PERSIST, 'sessions');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const CODE_TTL_MS = 10 * 60 * 1000;                // verification code lifetime: 10 min
const CODE_MAX_ATTEMPTS = 5;                       // wrong tries before a code is burned
const RESEND_COOLDOWN_MS = 30 * 1000;              // min gap between code sends

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
    await fs.writeFile(USERS_FILE, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

function publicUser(userId, rec) {
    return { userId, email: rec.email, username: rec.username, name: rec.username };
}

export async function countUsers() {
    return Object.keys(await readUsers()).length;
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
