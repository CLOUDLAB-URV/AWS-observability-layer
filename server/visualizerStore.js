'use strict';

// Per-(user, chat) storage for the sigils feature (the MCP-push visualizer).
// Each chat owns an isolated folder holding the current
// deployed state as a resource map (keyed by stable id), the last rendered D2
// diagram, and a meta.json (session name + timestamps).
//
// The agent pushes incremental CHANGES (upsert/delete per resource), not the full
// state — the backend is the one that keeps an authoritative, detailed picture of
// what is live by applying those changes onto state.json. So state.json is a map
// `{ [key]: resource }`, NOT an append-only log: deletes remove a key, upserts
// replace it, and there is no history to replay.
//
// Layout: persistence/deployed-state/<userId>/<chatId>/{state.json, diagram.d2, meta.json}
// A `chatId` IS a session id; `name` is the human-facing session name (auto-assigned
// on first deploy, editable from the web). The storage key is (userId, chatId);
// userId is a real owner id (see tokenStore.js), so the layout supports multiple
// users without touching call sites.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { persistRoot } from './persistence.js';

const ROOT = path.join(persistRoot(), 'deployed-state');

// Serialize writes per (user, chat) with an enqueue pattern so
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

// A session NAME is human-facing: allow spaces and common punctuation (unlike the
// id sanitizer, which is a storage-key charset). Strips control chars / line breaks
// and collapses whitespace runs. Returns the name capped at 60 chars, or null if
// empty after trimming.
export function sanitizeName(raw) {
    const name = String(raw ?? '')
        .replace(/[\x00-\x1f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!name) {
        return null;
    }
    return name.slice(0, 60);
}

// Normalize a display name for equality checks: lowercase + collapse whitespace. Two names
// that differ only in case/spacing count as the same, so "S3 Pipeline" and "s3  pipeline"
// can't both exist (diagrams are classified by name — the name is the identity).
export function normalizeName(raw) {
    return String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Does any OTHER diagram of this user already carry `name` (case/space-insensitive)?
// `exceptChatId` excludes the diagram being renamed from clashing with itself.
export async function nameConflict(userId, name, exceptChatId = null) {
    const target = normalizeName(name);
    if (!target) {
        return false;
    }
    const chats = await listChats(userId);
    return chats.some((c) => c.chatId !== exceptChatId && normalizeName(c.name) === target);
}

// Turn `base` into a name no other diagram uses, appending " 2", " 3", … until it's free.
// The 60-char cap is preserved (trim the base so the suffix always fits). Used as the
// last-resort fallback when the AI keeps proposing taken names.
export async function uniqueName(userId, base, exceptChatId = null) {
    const root = sanitizeName(base) || 'Untitled sigil';
    if (!(await nameConflict(userId, root, exceptChatId))) {
        return root;
    }
    for (let n = 2; n < 1000; n += 1) {
        const suffix = ` ${n}`;
        const candidate = `${root.slice(0, 60 - suffix.length)}${suffix}`;
        if (!(await nameConflict(userId, candidate, exceptChatId))) {
            return candidate;
        }
    }
    return `${root.slice(0, 48)} ${Date.now()}`; // pathological fallback — always unique
}

// Read a session's display name from meta, falling back to the legacy `project`
// field so chats created before the rename still show a label.
function metaName(meta) {
    return meta.name || meta.project || '';
}

function chatDir(userId, chatId) {
    return path.join(ROOT, userId, chatId);
}

function files(userId, chatId) {
    const dir = chatDir(userId, chatId);
    return {
        state: path.join(dir, 'state.json'),
        diagram: path.join(dir, 'diagram.d2'),
        meta: path.join(dir, 'meta.json'),
        chat: path.join(dir, 'chat.json')
    };
}

async function ensureChat(userId, chatId) {
    await fs.mkdir(chatDir(userId, chatId), { recursive: true });
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
export function readState(userId, chatId) {
    return readJsonObject(files(userId, chatId).state);
}

export async function readDiagram(userId, chatId) {
    try {
        return await fs.readFile(files(userId, chatId).diagram, 'utf8');
    } catch {
        return '';
    }
}

// Read a session's meta, normalizing the `deployed` flag to a boolean (default
// false = a "Design" diagram: nothing is created in AWS yet). `true` = "Live":
// the resources actually exist in AWS. A diagram is one or the other, never mixed.
export async function readMeta(userId, chatId) {
    const meta = await readJsonObject(files(userId, chatId).meta);
    return { ...meta, deployed: meta.deployed === true };
}

export function writeDiagram(userId, chatId, d2Code) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        await fs.writeFile(files(userId, chatId).diagram, `${String(d2Code).trim()}\n`, 'utf8');
    });
}

// The diagram Q&A ("Ask") history is persisted per sigil so the conversation survives
// reloads and is rebuilt server-side (the client never supplies history). Capped so the
// file can't grow unbounded; the whole file goes away with the sigil (deleteChat).
const ASK_CHAT_LIMIT = 50;

// The sigil's saved Ask conversation: an array of { role: 'user'|'assistant', text, at }
// messages, oldest first ([] if none).
export async function readAskChat(userId, chatId) {
    const obj = await readJsonObject(files(userId, chatId).chat);
    return Array.isArray(obj.messages) ? obj.messages : [];
}

export function writeAskChat(userId, chatId, messages) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        await fs.writeFile(
            files(userId, chatId).chat,
            `${JSON.stringify({ messages: messages.slice(-ASK_CHAT_LIMIT) }, null, 2)}\n`,
            'utf8'
        );
    });
}

// Upsert meta.json: refresh updatedAt, stamp createdAt the first time, and set the
// session name ONLY when one is supplied AND none exists yet (the initial seed).
// Explicit renames go through renameSession. Assumes the chat dir already exists.
async function touchMeta(userId, chatId, { initialName, initialDeployed } = {}) {
    const { meta } = files(userId, chatId);
    const existing = await readJsonObject(meta);
    const now = new Date().toISOString();
    const currentName = metaName(existing);
    const isNew = !existing.createdAt;
    const next = {
        name: currentName || (initialName ? String(initialName) : ''),
        // Preserve the diagram's mode; only seed it (from initialDeployed) on the
        // very first write, so a push never silently flips Design ↔ Live.
        deployed: existing.deployed === true || (isNew && initialDeployed === true),
        createdAt: existing.createdAt || now,
        updatedAt: now
    };
    await fs.writeFile(meta, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

// Mint a brand-new chat id server-side and seed its meta — the ONLY place a chatId is
// ever generated (the MCP layer never invents one, it only ever passes names around).
// `nameHint` is de-duplicated via uniqueName so the caller gets back the actual assigned
// name. `initialDeployed` seeds the sigil's mode at creation so a caller reporting an
// already-live architecture doesn't hit the "can't mix modes" check on the very next
// applyChanges/deployments call. Returns { chatId, name }.
export async function createChat(userId, nameHint, initialDeployed = false) {
    const chatId = randomUUID();
    await ensureChat(userId, chatId);
    const name = await uniqueName(userId, nameHint || 'Untitled sigil', chatId);
    await touchMeta(userId, chatId, { initialName: name, initialDeployed: initialDeployed === true });
    return { chatId, name };
}

// Explicitly (re)name a session. Used by the auto-namer on first deploy and by the
// web UI's rename control. Returns the persisted meta.
export function renameSession(userId, chatId, name) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        const { meta } = files(userId, chatId);
        const existing = await readJsonObject(meta);
        const now = new Date().toISOString();
        const next = {
            name: String(name || ''),
            deployed: existing.deployed === true, // preserve the diagram's mode
            createdAt: existing.createdAt || now,
            updatedAt: now
        };
        await fs.writeFile(meta, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        return next;
    });
}

// Set a diagram's mode: true = "Live" (deployed to AWS), false = "Design". Used by
// the deploy transition (Design → Live). Preserves name/timestamps. Returns the
// persisted meta.
export function setDeployed(userId, chatId, deployed) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        const { meta } = files(userId, chatId);
        const existing = await readJsonObject(meta);
        const now = new Date().toISOString();
        const next = {
            name: metaName(existing),
            deployed: deployed === true,
            createdAt: existing.createdAt || now,
            updatedAt: now
        };
        await fs.writeFile(meta, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        return next;
    });
}

// Tear down a Live sigil back to "Design": the inverse of the deploy transition. Records
// that the coding agent destroyed the real AWS resources — Sigilum itself has no AWS access.
// Atomic Live → Design: flip meta.deployed to false AND re-stamp EVERY resource in state.json
// as deployed:false, dropping each resource's now-moot `deploy_note` (a divergence reason is
// meaningless once the whole sigil is Design and every resource converges to deployed:false).
// Crucially it KEEPS every resource — a teardown never deletes a node; only an explicit
// op:'delete' (or a whole-sigil delete) removes one. Preserves name/createdAt and all other
// resource fields (incl. `code`). Returns the resulting resources as an array.
export function tearDown(userId, chatId) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        const { state: stateFile, meta } = files(userId, chatId);
        const state = await readJsonObject(stateFile);
        for (const key of Object.keys(state)) {
            const resource = state[key];
            if (!resource || typeof resource !== 'object') {
                continue;
            }
            resource.deployed = false;
            delete resource.deploy_note; // converged to Design → the divergence reason no longer applies
        }
        await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

        const existing = await readJsonObject(meta);
        const now = new Date().toISOString();
        const nextMeta = {
            name: metaName(existing),
            deployed: false,
            createdAt: existing.createdAt || now,
            updatedAt: now
        };
        await fs.writeFile(meta, `${JSON.stringify(nextMeta, null, 2)}\n`, 'utf8');
        return Object.values(state);
    });
}

// Apply a batch of incremental changes to the chat's current state and upsert meta.
// Each change is `{ op: 'upsert' | 'delete', type, id, ...resourceFields }`:
//   - upsert → store/replace the resource under its key (the full detailed record).
//   - delete → remove that key.
// The backend keeps the authoritative state; the agent only ever sends the delta.
// `initialName` seeds the session name only when it has none yet. Returns the
// resulting resources as an array (Object.values) for rendering.
export function applyChanges(userId, chatId, changes, initialName, initialDeployed) {
    return enqueue(`${userId}/${chatId}`, async () => {
        await ensureChat(userId, chatId);
        const { state: stateFile } = files(userId, chatId);
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
                // Stamp the deployment state explicitly on disk: an agent-set per-resource
                // `deployed` wins (a deliberate divergence, e.g. a failed create on a Live
                // sigil); otherwise the resource inherits the sigil mode.
                if (typeof resource.deployed !== 'boolean') {
                    resource.deployed = initialDeployed === true;
                }
                // Keep the divergence reason ("why it failed / why it's undeployed") sticky while
                // the resource STAYS divergent from the sigil mode: a full-replace upsert that
                // omits `deploy_note` would otherwise erase a failed resource's explanation. When
                // the resource converges to the sigil mode (e.g. a failed create finally succeeds),
                // the note is not carried over, so it clears. A new note always replaces.
                const divergent = resource.deployed !== (initialDeployed === true);
                if (resource.deploy_note === undefined && divergent && typeof state[key]?.deploy_note === 'string') {
                    resource.deploy_note = state[key].deploy_note;
                }
                // Code is the exception to full-replace: source planned in the DESIGN phase must
                // survive every later push — the deploy→Live re-report (real ARNs, no code) and
                // partial follow-ups — so the Live sigil shows the exact deployed source. Carry
                // the stored code forward whenever a push omits it; sending a new `code` replaces
                // it. (Clearing code via an empty array isn't supported — an acceptable limit.)
                if (resource.code === undefined && Array.isArray(state[key]?.code)) {
                    resource.code = state[key].code;
                }
                // Attachments (security group, IAM role, launch template…) are planned in the DESIGN
                // phase alongside the resource and almost never repeated afterwards, so the same
                // full-replace hazard applies: the deploy→Live re-report carries real ARNs and no
                // attachments, and would otherwise wipe them. A new array always replaces.
                if (resource.attachments === undefined && Array.isArray(state[key]?.attachments)) {
                    resource.attachments = state[key].attachments;
                }
                // Same reasoning for the resource's role: it is written once in the DESIGN phase and
                // rarely repeated, so the deploy→Live re-report (real ARNs, no purpose) and every
                // partial follow-up would otherwise erase it. A new purpose always replaces.
                if (resource.purpose === undefined && typeof state[key]?.purpose === 'string') {
                    resource.purpose = state[key].purpose;
                }
                // Network placement (which VPC / subnet box the node is drawn in) and a subnet's
                // public/private scope. Same reasoning again, and it matters most on the deploy
                // path: the Design push states the containment, then the Live re-report sends the
                // real ARNs and typically NOT the vpc/subnet, which would otherwise drop the node
                // straight out of its box. An empty string is the agent's explicit "take it out of
                // the container" gesture (normalizeChanges keeps it as a sentinel), so it clears
                // instead of carrying forward.
                for (const field of ['vpc', 'subnet', 'scope']) {
                    if (resource[field] === undefined && typeof state[key]?.[field] === 'string') {
                        resource[field] = state[key][field];
                    }
                    if (resource[field] === '') {
                        delete resource[field];
                    }
                }
                state[key] = resource;
            }
        }
        await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await touchMeta(userId, chatId, { initialName, initialDeployed });
        return Object.values(state);
    });
}

// List a user's chats (newest first) with their session name + timestamps.
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
                    name: metaName(meta),
                    deployed: meta.deployed === true,
                    createdAt: meta.createdAt || null,
                    updatedAt: meta.updatedAt || null
                };
            })
    );
    return chats.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// Permanently delete a single chat/diagram (its whole folder). Web-only (the owner deletes
// from the UI). Best-effort: a missing directory is fine. Serialized through the chat's write
// queue so it never races an in-flight push; both ids are sanitized so a bad value can't
// escape ROOT. Returns true when a valid id was targeted.
export function deleteChat(userId, chatId) {
    const uid = sanitizeId(userId);
    const cid = sanitizeId(chatId);
    if (!uid || !cid) {
        return Promise.resolve(false);
    }
    return enqueue(`${uid}/${cid}`, async () => {
        await fs.rm(chatDir(uid, cid), { recursive: true, force: true });
        return true;
    });
}

// Remove every chat/diagram a user owns (used when the account is deleted). Best-effort: a
// missing directory is fine. The userId is sanitized so a bad value can never reach outside ROOT.
export async function deleteAllForUser(userId) {
    const id = sanitizeId(userId);
    if (!id) {
        return;
    }
    await fs.rm(path.join(ROOT, id), { recursive: true, force: true });
}
