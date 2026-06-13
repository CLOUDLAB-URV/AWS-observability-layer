'use strict';

// Load .env (GCP_PROJECT_ID, CLOUD_ML_REGION, …) before anything reads it, so the
// backend is self-configured on start without injecting env vars on the CLI.
// Optional: the server still boots (and renders diagrams) if .env is absent.
import process from 'node:process';
try {
    process.loadEnvFile(new URL('.env', import.meta.url));
} catch {
    // No .env file — rely on whatever is already in the environment.
}

import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { renderDiagramSvg } from './diagram.js';
import { runFlow } from './graph.js';
import * as store from './projectStore.js';

const PORT = Number(process.env.PORT || 3001);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Single shared session (demo scope): one diagram, one mode.
let busy = false;

function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of wss.clients) {
        if (socket.readyState === socket.OPEN) {
            socket.send(payload);
        }
    }
}

async function pushState(socket) {
    const mode = await store.getMode();
    const d2 = await store.readDiagram();
    const { svg, error } = await renderDiagramSvg(d2);
    const message = JSON.stringify({ type: 'init', mode, svg, renderError: error });
    socket.send(message);
}

// Transport-level guards, then hand the turn to the orchestration graph.
async function handleChat(text) {
    const mode = await store.getMode();
    await runFlow({ trigger: 'chat', mode, text }, broadcast);
}

async function handleDeploy() {
    const mode = await store.getMode();
    if (mode !== 'preview') {
        broadcast({ type: 'status', text: 'Already in deployed mode.' });
        return;
    }

    const d2 = await store.readDiagram();
    if (!d2.trim()) {
        broadcast({ type: 'error', message: 'Nothing to deploy: the diagram is empty.' });
        return;
    }

    await runFlow({ trigger: 'deploy', mode }, broadcast);
}

async function handleTeardown() {
    const mode = await store.getMode();
    if (mode !== 'deployed') {
        broadcast({ type: 'status', text: 'Nothing to tear down — not in deployed mode.' });
        return;
    }
    await runFlow({ trigger: 'teardown', mode }, broadcast);
}

wss.on('connection', (socket) => {
    pushState(socket).catch((error) => {
        socket.send(JSON.stringify({ type: 'error', message: String(error?.message || error) }));
    });

    socket.on('message', async (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }

        if (busy) {
            socket.send(JSON.stringify({ type: 'error', message: 'An operation is already running — wait for it to finish.' }));
            return;
        }

        busy = true;
        try {
            if (message.type === 'chat' && typeof message.text === 'string' && message.text.trim()) {
                await handleChat(message.text.trim());
            } else if (message.type === 'deploy') {
                await handleDeploy();
            } else if (message.type === 'teardown') {
                await handleTeardown();
            }
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            console.error('[operation failed]', error);
            broadcast({ type: 'chat-done' });
            broadcast({ type: 'error', message: text });
        } finally {
            busy = false;
        }
    });
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

await store.initProject();
server.listen(PORT, () => {
    console.log(`aws-architect-web server listening on http://127.0.0.1:${PORT} (ws path /ws)`);
});
