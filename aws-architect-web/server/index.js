'use strict';

import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { renderDiagramSvg } from './diagram.js';
import { runPreviewTurn, runAwsAgent, runStateMerge } from './agent.js';
import * as store from './projectStore.js';

const PORT = Number(process.env.PORT || 3001);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Single shared session (demo scope): one diagram, one mode, one chat history.
const previewHistory = [];
let busy = false;

function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of wss.clients) {
        if (socket.readyState === socket.OPEN) {
            socket.send(payload);
        }
    }
}

async function pushDiagram() {
    const d2 = await store.readDiagram();
    const { svg, error } = await renderDiagramSvg(d2);
    if (error) {
        broadcast({ type: 'render-error', error });
    } else {
        broadcast({ type: 'render-svg', svg });
    }
}

async function pushState(socket) {
    const mode = await store.getMode();
    const d2 = await store.readDiagram();
    const { svg, error } = await renderDiagramSvg(d2);
    const message = JSON.stringify({ type: 'init', mode, svg, renderError: error });
    socket.send(message);
}

async function handleChat(text) {
    const mode = await store.getMode();

    if (mode === 'preview') {
        const d2 = await runPreviewTurn(previewHistory, text, broadcast);
        broadcast({ type: 'chat-done' });
        if (d2 !== null) {
            await pushDiagram();
        }
        return;
    }

    // Deployed mode: every prompt executes against AWS, then re-merges.
    await runAwsAgent(text, broadcast);
    broadcast({ type: 'chat-done' });
    const merged = await runStateMerge(broadcast);
    if (merged !== null) {
        await pushDiagram();
    }
    broadcast({ type: 'status', text: 'Done.' });
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

    broadcast({ type: 'status', text: 'Deploying architecture to AWS…' });
    await runAwsAgent(
        'Deploy the architecture described in the current D2 diagram into AWS. Create every resource the diagram represents, using sensible defaults and free-tier-friendly sizes where the diagram does not specify them.',
        broadcast
    );
    broadcast({ type: 'chat-done' });

    const merged = await runStateMerge(broadcast);
    await store.setMode('deployed');
    broadcast({ type: 'mode', mode: 'deployed' });
    if (merged !== null) {
        await pushDiagram();
    }
    broadcast({ type: 'status', text: 'Deployment complete — now in deployed mode.' });
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
