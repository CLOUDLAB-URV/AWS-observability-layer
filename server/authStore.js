'use strict';

// Persistence for login: users and sessions, stored under the same persistence/ tree as the
// rest of the app (mounted as a Docker volume in the deploy, so it survives container
// recreation). Kept deliberately small and file-based, mirroring tokenStore.js.
//
// Layout:
//   persistence/users.json          → { [userId]: { sub, email, name, picture, createdAt } }
//   persistence/sessions/<sid>.json → { userId, createdAt, expiresAt }
//
// A user is keyed internally by Google's stable `sub`; we mint our own `userId` (usr_<hex>)
// so the rest of the codebase keeps using opaque user ids (visualizerStore, tokenStore).

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSIST = path.join(__dirname, 'persistence');
const USERS_FILE = path.join(PERSIST, 'users.json');
const SESSIONS_DIR = path.join(PERSIST, 'sessions');

// Sessions last 30 days unless logged out sooner.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function maxUsers() {
    const n = Number.parseInt(process.env.MAX_USERS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

// Serialize writes to users.json so concurrent logins never interleave.
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

export async function countUsers() {
    return Object.keys(await readUsers()).length;
}

function publicUser(userId, rec) {
    return { userId, email: rec.email, name: rec.name, picture: rec.picture };
}

export async function getUser(userId) {
    const rec = (await readUsers())[userId];
    return rec ? publicUser(userId, rec) : null;
}

// Find a user by Google `sub`, creating one if needed. Returns the public user, or null when
// the user is new AND the MAX_USERS cap is already reached (caller should block the login).
export async function findOrCreateUser({ sub, email, name, picture }) {
    const id = String(sub ?? '').trim();
    if (!id) {
        return null;
    }
    return enqueue(async () => {
        const map = await readUsers();
        // Existing user (matched by Google sub): refresh profile, always allowed back in.
        const existingId = Object.keys(map).find((uid) => map[uid].sub === id);
        if (existingId) {
            map[existingId] = { ...map[existingId], email, name, picture };
            await writeUsers(map);
            return publicUser(existingId, map[existingId]);
        }
        // New user: enforce the cap.
        if (Object.keys(map).length >= maxUsers()) {
            return null;
        }
        const userId = `usr_${randomBytes(8).toString('hex')}`;
        map[userId] = { sub: id, email: email || '', name: name || '', picture: picture || '', createdAt: new Date().toISOString() };
        await writeUsers(map);
        return publicUser(userId, map[userId]);
    });
}

export async function createSession(userId) {
    const sid = randomBytes(24).toString('hex');
    const now = Date.now();
    const record = { userId, createdAt: new Date(now).toISOString(), expiresAt: now + SESSION_TTL_MS };
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.writeFile(path.join(SESSIONS_DIR, `${sid}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return sid;
}

// Returns the session's public user if the sid is valid and unexpired, else null.
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
