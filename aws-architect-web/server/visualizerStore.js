'use strict';

// Per-chat storage for the "Deployed state" feature (the MCP-push visualizer),
// kept separate from projectStore.js so the existing preview/deploy flow is never
// destabilized. Each chat owns an isolated folder holding the current deployed
// state as a resource map (keyed by stable id), the last rendered D2 diagram, and a
// meta.json (friendly project label + timestamps).
//
// The agent pushes incremental CHANGES (upsert/delete per resource), not the full
// state — the backend is the one that keeps an authoritative, detailed picture of
// what is live by applying those changes onto state.json. So state.json is a map
// `{ [key]: resource }`, NOT an append-only log: deletes remove a key, upserts
// replace it, and there is no history to replay.
//
// Layout: persistence/deployed-state/<chatId>/{state.json, diagram.d2, meta.json}
// `project` is just a human-readable label; the storage key is the chatId.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'persistence', 'deployed-state');

// Serialize writes per chat, mirroring projectStore.js's enqueue pattern so
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

function chatDir(chatId) {
    return path.join(ROOT, chatId);
}

function files(chatId) {
    const dir = chatDir(chatId);
    return {
        state: path.join(dir, 'state.json'),
        diagram: path.join(dir, 'diagram.d2'),
        meta: path.join(dir, 'meta.json')
    };
}

async function ensureChat(chatId) {
    await fs.mkdir(chatDir(chatId), { recursive: true });
}

async function readJsonObject(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

// The stable key a resource is stored under in the state map: its id when present,
// else a type+name composite. Mirrors keyOf in the ingest path so changes line up.
function keyOf(resource) {
    const id = String(resource?.id ?? '').trim();
    if (id) {
        return id;
    }
    const name = String(resource?.name ?? '').trim();
    return name ? `${resource?.type ?? '?'}:${name}` : '';
}

// The chat's current deployed state as a map `{ [key]: resource }` ({} if none).
export function readState(chatId) {
    return readJsonObject(files(chatId).state);
}

export async function readDiagram(chatId) {
    try {
        return await fs.readFile(files(chatId).diagram, 'utf8');
    } catch {
        return '';
    }
}

export function readMeta(chatId) {
    return readJsonObject(files(chatId).meta);
}

export function writeDiagram(chatId, d2Code) {
    return enqueue(chatId, async () => {
        await ensureChat(chatId);
        await fs.writeFile(files(chatId).diagram, `${String(d2Code).trim()}\n`, 'utf8');
    });
}

// Upsert meta.json: set the project label (if provided), refresh updatedAt, and
// stamp createdAt the first time. Assumes the chat dir already exists.
async function touchMeta(chatId, project) {
    const { meta } = files(chatId);
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

// Apply a batch of incremental changes to the chat's current state and upsert meta.
// Each change is `{ op: 'upsert' | 'delete', type, id, ...resourceFields }`:
//   - upsert → store/replace the resource under its key (the full detailed record).
//   - delete → remove that key.
// The backend keeps the authoritative state; the agent only ever sends the delta.
// Returns the resulting resources as an array (Object.values) for rendering.
export function applyChanges(chatId, changes, project) {
    return enqueue(chatId, async () => {
        await ensureChat(chatId);
        const { state: stateFile } = files(chatId);
        const state = await readJsonObject(stateFile);
        for (const change of changes) {
            const key = keyOf(change);
            if (!key) {
                continue;
            }
            if (change.op === 'delete') {
                delete state[key];
            } else {
                // upsert: keep the full detailed record, minus the transient op verb.
                const { op, ...resource } = change;
                state[key] = resource;
            }
        }
        await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await touchMeta(chatId, project);
        return Object.values(state);
    });
}

// List all chats (newest first) with their friendly label + timestamps.
export async function listChats() {
    let entries;
    try {
        entries = await fs.readdir(ROOT, { withFileTypes: true });
    } catch {
        return [];
    }
    const chats = await Promise.all(
        entries
            .filter((e) => e.isDirectory())
            .map(async (e) => {
                const meta = await readMeta(e.name);
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
