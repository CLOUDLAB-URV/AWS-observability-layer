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
import * as visualizerStore from './visualizerStore.js';
import * as tokenStore from './tokenStore.js';
import { extractOutputMessages } from './agents/aws/mcp.js';
import { runStateViz, suggestSessionName } from './agents/stateviz/index.js';

const PORT = Number(process.env.PORT || 3001);

const app = express();
app.use(express.json({ limit: '5mb' }));
const server = http.createServer(app);
// Two WebSocket endpoints on one HTTP server: '/ws' (legacy design flow) and
// '/ws-visualizer' (deployed-state feature). They MUST use noServer + manual
// upgrade routing — two `WebSocketServer({ server, path })` on the same server
// conflict (the first aborts non-matching upgrades with 400 before the second
// can handle them).
const wss = new WebSocketServer({ noServer: true });
const vizWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname === '/ws-visualizer') {
        vizWss.handleUpgrade(req, socket, head, (ws) => vizWss.emit('connection', ws, req));
    } else {
        socket.destroy();
    }
});

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
    // Allow deploy from preview (first deploy) and partial (retry). Block only a
    // fully-deployed architecture.
    if (mode === 'deployed') {
        broadcast({ type: 'status', text: 'Already fully deployed.' });
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
    // Allow teardown from deployed and partial (remove whatever was created).
    if (mode === 'preview') {
        broadcast({ type: 'status', text: 'Nothing to tear down — not deployed.' });
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

// ---------------------------------------------------------------------------
// "Deployed state" feature (MCP-push visualizer)
// ---------------------------------------------------------------------------

// Send a message to every visualizer client subscribed to a given (user, chat).
function broadcastToChat(userId, chatId, message) {
    const payload = JSON.stringify(message);
    for (const socket of vizWss.clients) {
        if (socket.readyState === socket.OPEN && socket._userId === userId && socket._chatId === chatId) {
            socket.send(payload);
        }
    }
}

// Normalize whatever the MCP tool uploaded into the canonical operation shape
// ({ action, resource_state?, error? }) that the rest of the pipeline expects.
// Accepts: an array already in that shape, raw call_aws results, or a
// structuredContent envelope.
function normalizeOperations(body) {
    if (Array.isArray(body?.operations)) {
        return body.operations
            .map((op) => {
                const action = op.action || op.cli_command || op.command;
                if (!action) {
                    return null;
                }
                const entry = { action: String(action) };
                const state = op.resource_state ?? op.response ?? op.result;
                if (state !== undefined) {
                    entry.resource_state = state;
                }
                if (op.error) {
                    entry.error = String(op.error);
                }
                return entry;
            })
            .filter(Boolean);
    }
    if (body?.structuredContent) {
        return extractOutputMessages(body.structuredContent);
    }
    return [];
}

// Bearer-token auth → resolves req.userId, or 401.
async function requireToken(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const identity = await tokenStore.verify(token);
    if (!identity) {
        res.status(401).json({ error: 'Invalid or missing API token.' });
        return;
    }
    req.userId = identity.userId;
    next();
}

// Optional Bearer auth → req.userId if a valid token is present, else the owner
// user. Used by read endpoints the web UI hits same-origin without a token (the web
// operates as the owner of this machine); the MCP always sends a token and gets its
// real user.
async function resolveUser(req, _res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const identity = token ? await tokenStore.verify(token) : null;
    req.userId = identity ? identity.userId : await tokenStore.getOwnerUserId();
    next();
}

// Ingest: the MCP tool POSTs a batch of AWS operations for a chat. We append them,
// regenerate the deployed-state D2, render it, and push it live to any web clients
// watching that chat. `project` is a friendly label stored in meta.
app.post('/api/chats/:chatId/deployments', requireToken, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }

    const operations = normalizeOperations(req.body);
    if (operations.length === 0) {
        res.status(400).json({ error: 'No operations to ingest.' });
        return;
    }

    // An agent-supplied label is only a hint for a brand-new session; the name is
    // otherwise auto-assigned by the backend and editable from the web.
    const nameHint = visualizerStore.sanitizeName(req.body?.project) || '';

    try {
        // Is this a new session? (no name yet) — decide BEFORE the append seeds meta.
        const priorMeta = await visualizerStore.readMeta(req.userId, chatId);
        const isNewSession = !(priorMeta.name || priorMeta.project);

        await visualizerStore.appendDeployment(req.userId, chatId, operations, nameHint);

        // Auto-name a new session from its architecture when no hint was provided.
        let name = nameHint || priorMeta.name || priorMeta.project || '';
        if (isNewSession && !nameHint) {
            const allOps = await visualizerStore.readOperations(req.userId, chatId);
            const suggested = await suggestSessionName(allOps);
            if (suggested) {
                await visualizerStore.renameSession(req.userId, chatId, suggested);
                name = suggested;
            }
        }

        const d2 = await runStateViz(req.userId, chatId);
        const { svg, error } = await renderDiagramSvg(d2);
        broadcastToChat(req.userId, chatId, { type: 'render-svg', svg, renderError: error });
        res.json({ ok: true, chat: chatId, name, operations: operations.length, rendered: Boolean(svg) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[deployment ingest failed]', error);
        res.status(500).json({ error: message });
    }
});

// List the user's chats (newest first). The MCP uses this (with a token) for
// list_chats; the web UI hits it same-origin (no token → owner user).
app.get('/api/chats', resolveUser, async (req, res) => {
    res.json({ chats: await visualizerStore.listChats(req.userId) });
});

// Full context for one chat: name + cumulative operations + current D2. Used by
// the MCP's load_chat so the agent can resume with the already-created IDs/ARNs.
app.get('/api/chats/:chatId', requireToken, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const [meta, operations, d2] = await Promise.all([
        visualizerStore.readMeta(req.userId, chatId),
        visualizerStore.readOperations(req.userId, chatId),
        visualizerStore.readDiagram(req.userId, chatId)
    ]);
    res.json({ chat: chatId, name: meta.name || meta.project || '', operations, d2 });
});

// Rename a session. Hit by the web UI same-origin (owner user) to override the
// auto-assigned name.
app.patch('/api/chats/:chatId', resolveUser, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const name = visualizerStore.sanitizeName(req.body?.name);
    if (!name) {
        res.status(400).json({ error: 'A non-empty name is required.' });
        return;
    }
    const meta = await visualizerStore.renameSession(req.userId, chatId, name);
    res.json({ chat: chatId, name: meta.name });
});

// Current deployed-state diagram (SVG) for a chat.
app.get('/api/chats/:chatId/diagram', resolveUser, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const d2 = await visualizerStore.readDiagram(req.userId, chatId);
    const { svg, error } = await renderDiagramSvg(d2);
    res.json({ chat: chatId, svg, renderError: error });
});

// Token management for the web UI (the owner user of this machine).
app.get('/api/tokens', async (_req, res) => {
    res.json({ tokens: await tokenStore.list() });
});

app.post('/api/tokens', async (req, res) => {
    // userId defaults to the owner inside tokenStore.create.
    const { token } = await tokenStore.create(undefined, String(req.body?.label || ''));
    // Returned in full exactly once so the user can copy it into the MCP config.
    res.json({ token });
});

// Visualizer WebSocket: a client subscribes to one project and receives live
// diagram updates whenever a deployment is pushed for it.
vizWss.on('connection', (socket) => {
    socket.on('message', async (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (message.type === 'subscribe') {
            const chatId = visualizerStore.sanitizeChatId(message.chatId);
            if (!chatId) {
                socket.send(JSON.stringify({ type: 'error', message: 'Invalid chat id.' }));
                return;
            }
            // The web client maps to the owner user of this machine.
            socket._userId = await tokenStore.getOwnerUserId();
            socket._chatId = chatId;
            const d2 = await visualizerStore.readDiagram(socket._userId, chatId);
            const { svg, error } = await renderDiagramSvg(d2);
            socket.send(JSON.stringify({ type: 'init', chat: chatId, svg, renderError: error }));
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
