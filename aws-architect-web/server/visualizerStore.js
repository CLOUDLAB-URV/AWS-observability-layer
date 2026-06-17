'use strict';

// Per-(user, chat) storage for the "Deployed state" feature (the MCP-push
// visualizer), kept separate from projectStore.js so the existing preview/deploy
// flow is never destabilized. Each chat owns an isolated folder holding the
// cumulative AWS operations pushed from the user's agent, the last rendered D2
// diagram, and a meta.json (friendly project label + timestamps).
//
// Layout: data/visualizer/<userId>/<chatId>/{operations.json, diagram.d2, meta.json}
// `project` is just a human-readable label; the storage key is (userId, chatId).
// v1 keeps userId = "local"; the layout is already shaped for phase 2 multi-user
// without touching call sites.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'data', 'visualizer');

// Serialize writes per (user, chat), mirroring projectStore.js's enqueue pattern so
// concurrent pushes for the same chat never interleave file writes.
const writeQueues = new Map();

function enqueue(key, task) {
    const prev = writeQueues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    writeQueues.set(key, next.catch(() => {}));
    return next;
}

// Reject anything that could escape the storage root (path traversal / separators).
function sanitizeId(raw) {
    const id = String(raw ?? '').trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
        return null;
    }
    return id;
}

// Validate the human-readable project label (same charset rules).
export const sanitizeProjectId = sanitizeId;
// Validate a chat id (a UUID satisfies these rules).
export const sanitizeChatId = sanitizeId;

function chatDir(userId, chatId) {
    return path.join(ROOT, userId, chatId);
}

function files(userId, chatId) {
    const dir = chatDir(userId, chatId);
    return {
        operations: path.join(dir, 'operations.json'),
        diagram: path.join(dir, 'diagram.d2'),
        meta: path.join(dir, 'meta.json')
    };
}

async function ensureChat(userId, chatId) {
    await fs.mkdir(chatDir(userId, chatId), { recursive: true });
}

async function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function readJsonObject(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function readOperations(userId, chatId) {
    return readJsonArray(files(userId, chatId).operations);
}

export async function readDiagram(userId, chatId) {
    try {
        return await fs.readFile(files(userId, chatId).diagram, 'utf8');
    } catch {
        return '';
    }
}

export function readMeta(userId, chatId) {
    return readJsonObject(files(userId, chatId).meta);
}

export function writeDiagram(userId, chatId, d2Code) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        await fs.writeFile(files(userId, chatId).diagram, `${String(d2Code).trim()}\n`, 'utf8');
    });
}

// Upsert meta.json: set the project label (if provided), refresh updatedAt, and
// stamp createdAt the first time. Assumes the chat dir already exists.
async function touchMeta(userId, chatId, project) {
    const { meta } = files(userId, chatId);
    const existing = await readJsonObject(meta);
    const now = new Date().toISOString();
    const next = {
        project: project != null && project !== '' ? String(project) : existing.project || '',
        createdAt: existing.createdAt || now,
        updatedAt: now
    };
    await fs.writeFile(meta, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

// Append a batch of normalized operations ({ action, resource_state?, error? })
// to the chat's cumulative log and upsert meta. Returns the full operations array.
export function appendDeployment(userId, chatId, operations, project) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        const { operations: opsFile } = files(userId, chatId);
        const existing = await readJsonArray(opsFile);
        existing.push(...operations);
        await fs.writeFile(opsFile, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
        await touchMeta(userId, chatId, project);
        return existing;
    });
}

// Replace a chat's operations log wholesale (used when a push represents the full,
// current deployment rather than an increment). Returns the stored array.
export function replaceOperations(userId, chatId, operations, project) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        await fs.writeFile(files(userId, chatId).operations, `${JSON.stringify(operations, null, 2)}\n`, 'utf8');
        await touchMeta(userId, chatId, project);
        return operations;
    });
}

// List a user's chats (newest first) with their friendly label + timestamps.
export async function listChats(userId) {
    let entries;
    try {
        entries = await fs.readdir(path.join(ROOT, userId), { withFileTypes: true });
    } catch {
        return [];
    }
    const chats = await Promise.all(
        entries
            .filter((e) => e.isDirectory())
            .map(async (e) => {
                const meta = await readMeta(userId, e.name);
                return {
                    chatId: e.name,
                    project: meta.project || '',
                    createdAt: meta.createdAt || null,
                    updatedAt: meta.updatedAt || null
                };
            })
    );
    return chats.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
