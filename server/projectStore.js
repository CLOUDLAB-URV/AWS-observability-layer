'use strict';

// Persistent storage for the "Design" flow, organized per project so each design is
// isolated and reloads from disk on boot. The server keeps a single ACTIVE project
// (this is a local, single-user demo) and resolves every path from it, so graph.js
// and the agents keep calling readDiagram()/writeDiagram()/… with no project
// argument — only the active project changes underneath them.
//
// Layout: persistence/design/<projectId>/{diagram.d2, workflow.json, queue.json,
// session.json, meta.json, prompts/}. `projectId` is a slug of the friendly name
// (unique, readable); meta.json holds the name + timestamps.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'persistence', 'design');

const DEFAULT_PROJECT_ID = 'default';

// The active project all parameterless store calls resolve against.
let currentProjectId = DEFAULT_PROJECT_ID;

// Serializes writes the same way the extension's appState.writeQueue does.
let writeQueue = Promise.resolve();

function enqueue(task) {
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
}

function projectDir(id) {
    return path.join(ROOT, id);
}

function files(id) {
    const dir = projectDir(id);
    return {
        diagram: path.join(dir, 'diagram.d2'),
        workflow: path.join(dir, 'workflow.json'),
        queue: path.join(dir, 'queue.json'),
        session: path.join(dir, 'session.json'),
        meta: path.join(dir, 'meta.json'),
        prompts: path.join(dir, 'prompts')
    };
}

// Turn a friendly name into a filesystem-safe slug (a-z0-9-, collapsed, trimmed).
function slugify(name) {
    const slug = String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || 'project';
}

// Reject anything that could escape the storage root (path traversal / separators).
function sanitizeId(raw) {
    const id = String(raw ?? '').trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
        return null;
    }
    return id;
}

async function projectExists(id) {
    try {
        const stat = await fs.stat(projectDir(id));
        return stat.isDirectory();
    } catch {
        return false;
    }
}

async function readJsonObject(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

async function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Upsert meta.json: set the name (if provided), refresh updatedAt, stamp createdAt
// the first time. Assumes the project dir exists.
async function touchMeta(id, name) {
    const { meta } = files(id);
    const existing = await readJsonObject(meta);
    const now = new Date().toISOString();
    const next = {
        name: name != null && name !== '' ? String(name) : existing.name || id,
        createdAt: existing.createdAt || now,
        updatedAt: now
    };
    await fs.writeFile(meta, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
}

// Create a project dir with initial files + meta. Assumes `id` is free.
async function scaffold(id, name) {
    const f = files(id);
    await fs.mkdir(f.prompts, { recursive: true });
    await Promise.all([
        fs.writeFile(f.diagram, '', 'utf8'),
        fs.writeFile(f.workflow, '[]\n', 'utf8'),
        fs.writeFile(f.queue, '[]\n', 'utf8'),
        fs.writeFile(f.session, '{"mode":"preview"}\n', 'utf8')
    ]);
    await touchMeta(id, name);
}

// Ensure the storage root exists and there is at least the default project, then
// adopt the default as the active project. Safe to call repeatedly.
export async function initProject() {
    await fs.mkdir(ROOT, { recursive: true });
    if (!(await projectExists(DEFAULT_PROJECT_ID))) {
        await scaffold(DEFAULT_PROJECT_ID, 'Default');
    }
    currentProjectId = DEFAULT_PROJECT_ID;
}

export function getCurrentProjectId() {
    return currentProjectId;
}

// Switch the active project (validates it exists). Returns true on success.
export async function setCurrentProject(rawId) {
    const id = sanitizeId(rawId);
    if (!id || !(await projectExists(id))) {
        return false;
    }
    currentProjectId = id;
    return true;
}

// List all projects (newest activity first) with name + timestamps.
export async function listProjects() {
    let entries;
    try {
        entries = await fs.readdir(ROOT, { withFileTypes: true });
    } catch {
        return [];
    }
    const projects = await Promise.all(
        entries
            .filter((e) => e.isDirectory())
            .map(async (e) => {
                const meta = await readJsonObject(files(e.name).meta);
                return {
                    id: e.name,
                    name: meta.name || e.name,
                    createdAt: meta.createdAt || null,
                    updatedAt: meta.updatedAt || null
                };
            })
    );
    return projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// Create a new project from a friendly name. The folder is a unique slug of the
// name (suffixed -2, -3, … on collision). Returns { id, name }.
export function createProject(name) {
    return enqueue(async () => {
        const base = slugify(name);
        let id = base;
        let n = 2;
        while (await projectExists(id)) {
            id = `${base}-${n++}`;
        }
        await scaffold(id, name);
        return { id, name: String(name || id) };
    });
}

export async function readDiagram() {
    try {
        return await fs.readFile(files(currentProjectId).diagram, 'utf8');
    } catch {
        return '';
    }
}

export function writeDiagram(d2Code) {
    const id = currentProjectId;
    return enqueue(async () => {
        await fs.writeFile(files(id).diagram, `${d2Code.trim()}\n`, 'utf8');
        await touchMeta(id);
    });
}

export function readQueue() {
    return readJsonArray(files(currentProjectId).queue);
}

export function readWorkflow() {
    return readJsonArray(files(currentProjectId).workflow);
}

export function appendOperations(outputMessages) {
    if (outputMessages.length === 0) {
        return writeQueue;
    }

    const id = currentProjectId;
    return enqueue(async () => {
        const f = files(id);
        const [workflow, queue] = await Promise.all([
            readJsonArray(f.workflow),
            readJsonArray(f.queue)
        ]);
        workflow.push(...outputMessages);
        queue.push(...outputMessages);
        await Promise.all([
            fs.writeFile(f.workflow, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8'),
            fs.writeFile(f.queue, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
        ]);
        await touchMeta(id);
    });
}

export function clearQueue() {
    const id = currentProjectId;
    return enqueue(() => fs.writeFile(files(id).queue, '[]\n', 'utf8'));
}

export function clearWorkflow() {
    const id = currentProjectId;
    return enqueue(() => fs.writeFile(files(id).workflow, '[]\n', 'utf8'));
}

const MODES = new Set(['preview', 'deployed', 'partial']);

export async function getMode() {
    try {
        const session = JSON.parse(await fs.readFile(files(currentProjectId).session, 'utf8'));
        return MODES.has(session.mode) ? session.mode : 'preview';
    } catch {
        return 'preview';
    }
}

export function setMode(mode) {
    const id = currentProjectId;
    return enqueue(async () => {
        await fs.writeFile(files(id).session, `${JSON.stringify({ mode })}\n`, 'utf8');
        await touchMeta(id);
    });
}

export function archivePrompt(promptText) {
    const id = currentProjectId;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(files(id).prompts, `${timestamp}.md`);
    return enqueue(async () => {
        await fs.mkdir(files(id).prompts, { recursive: true });
        await fs.writeFile(filePath, promptText, 'utf8');
    });
}
