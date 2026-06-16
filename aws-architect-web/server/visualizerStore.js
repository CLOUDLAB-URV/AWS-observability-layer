'use strict';

// Per-project storage for the "Deployed state" feature (the MCP-push visualizer),
// kept separate from projectStore.js so the existing preview/deploy flow is never
// destabilized. Each project owns an isolated folder holding the cumulative AWS
// operations pushed from the user's agent plus the last rendered D2 diagram.
//
// v1 is single-user; the layout (data/visualizer/<projectId>/…) is intentionally
// shaped so phase 2 can become data/users/<userId>/projects/<projectId>/… without
// touching call sites.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'data', 'visualizer');

// Serialize writes per project, mirroring projectStore.js's enqueue pattern so
// concurrent pushes for the same project never interleave file writes.
const writeQueues = new Map();

function enqueue(projectId, task) {
    const prev = writeQueues.get(projectId) ?? Promise.resolve();
    const next = prev.then(task, task);
    writeQueues.set(projectId, next.catch(() => {}));
    return next;
}

// Reject anything that could escape the project root (path traversal / separators).
export function sanitizeProjectId(raw) {
    const id = String(raw ?? '').trim();
    if (!id || id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
        return null;
    }
    return id;
}

function projectDir(projectId) {
    return path.join(ROOT, projectId);
}

function files(projectId) {
    const dir = projectDir(projectId);
    return {
        operations: path.join(dir, 'operations.json'),
        diagram: path.join(dir, 'diagram.d2')
    };
}

async function ensureProject(projectId) {
    await fs.mkdir(projectDir(projectId), { recursive: true });
}

async function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function readOperations(projectId) {
    return readJsonArray(files(projectId).operations);
}

export async function readDiagram(projectId) {
    try {
        return await fs.readFile(files(projectId).diagram, 'utf8');
    } catch {
        return '';
    }
}

export function writeDiagram(projectId, d2Code) {
    return enqueue(projectId, async () => {
        await ensureProject(projectId);
        await fs.writeFile(files(projectId).diagram, `${String(d2Code).trim()}\n`, 'utf8');
    });
}

// Append a batch of normalized operations ({ action, resource_state?, error? })
// to the project's cumulative log. Returns the full operations array afterwards.
export function appendDeployment(projectId, operations) {
    return enqueue(projectId, async () => {
        await ensureProject(projectId);
        const { operations: opsFile } = files(projectId);
        const existing = await readJsonArray(opsFile);
        existing.push(...operations);
        await fs.writeFile(opsFile, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
        return existing;
    });
}

// Replace a project's operations log wholesale (used when a push represents the
// full, current deployment rather than an increment). Returns the stored array.
export function replaceOperations(projectId, operations) {
    return enqueue(projectId, async () => {
        await ensureProject(projectId);
        await fs.writeFile(files(projectId).operations, `${JSON.stringify(operations, null, 2)}\n`, 'utf8');
        return operations;
    });
}

export async function listProjects() {
    try {
        const entries = await fs.readdir(ROOT, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return [];
    }
}
