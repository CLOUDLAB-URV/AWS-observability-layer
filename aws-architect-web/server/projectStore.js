'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PROMPT_HISTORY_DIR = path.join(DATA_DIR, 'prompts');

const FILES = {
    diagram: path.join(DATA_DIR, 'diagram.d2'),
    workflow: path.join(DATA_DIR, 'workflow.json'),
    queue: path.join(DATA_DIR, 'queue.json'),
    session: path.join(DATA_DIR, 'session.json')
};

// Serializes writes the same way the extension's appState.writeQueue does.
let writeQueue = Promise.resolve();

function enqueue(task) {
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
}

export async function initProject() {
    await fs.mkdir(PROMPT_HISTORY_DIR, { recursive: true });
    for (const [key, filePath] of Object.entries(FILES)) {
        try {
            await fs.access(filePath);
        } catch {
            const initial = key === 'diagram' ? '' : key === 'session' ? '{"mode":"preview"}\n' : '[]\n';
            await fs.writeFile(filePath, initial, 'utf8');
        }
    }
}

export async function readDiagram() {
    return fs.readFile(FILES.diagram, 'utf8');
}

export function writeDiagram(d2Code) {
    return enqueue(() => fs.writeFile(FILES.diagram, `${d2Code.trim()}\n`, 'utf8'));
}

async function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function readQueue() {
    return readJsonArray(FILES.queue);
}

export function readWorkflow() {
    return readJsonArray(FILES.workflow);
}

export function appendOperations(outputMessages) {
    if (outputMessages.length === 0) {
        return writeQueue;
    }

    return enqueue(async () => {
        const [workflow, queue] = await Promise.all([
            readJsonArray(FILES.workflow),
            readJsonArray(FILES.queue)
        ]);
        workflow.push(...outputMessages);
        queue.push(...outputMessages);
        await Promise.all([
            fs.writeFile(FILES.workflow, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8'),
            fs.writeFile(FILES.queue, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
        ]);
    });
}

export function clearQueue() {
    return enqueue(() => fs.writeFile(FILES.queue, '[]\n', 'utf8'));
}

export function clearWorkflow() {
    return enqueue(() => fs.writeFile(FILES.workflow, '[]\n', 'utf8'));
}

export async function getMode() {
    try {
        const session = JSON.parse(await fs.readFile(FILES.session, 'utf8'));
        return session.mode === 'deployed' ? 'deployed' : 'preview';
    } catch {
        return 'preview';
    }
}

export function setMode(mode) {
    return enqueue(() => fs.writeFile(FILES.session, `${JSON.stringify({ mode })}\n`, 'utf8'));
}

export function archivePrompt(promptText) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(PROMPT_HISTORY_DIR, `${timestamp}.md`);
    return enqueue(() => fs.writeFile(filePath, promptText, 'utf8'));
}
