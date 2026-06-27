'use strict';

// Load env before anything reads it. In production the config is injected by the environment
// (the deploy's .env / container env) — nothing is baked into the image. For LOCAL dev without
// containers we load .env.local (gitignored secrets: GCP, token). process.loadEnvFile does NOT
// override already-set vars, so injected/OS env always wins. Both files are optional.
import process from 'node:process';
for (const file of ['.env.local', '.env']) {
    try {
        process.loadEnvFile(new URL(file, import.meta.url));
    } catch {
        // File absent — skip it.
    }
}

import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { renderDiagramSvg } from './diagram.js';
import { runFlow, resetConversation } from './graph.js';
import * as store from './projectStore.js';
import * as visualizerStore from './visualizerStore.js';
import * as tokenStore from './tokenStore.js';
import { features } from './features.js';
import { runStateViz, suggestSessionName } from './agents/stateviz/index.js';

const PORT = Number(process.env.PORT || 3001);

// Feature flags are driven by the environment (.env). Design & Deploy (the LangGraph
// orchestration flow: chat/deploy/teardown/projects) stays in STANDBY while
// features.design is off — the code is untouched but the server refuses to run runFlow,
// so no design request is ever processed. Set DESIGN_ENABLED=true in .env to reactivate.

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
        // Agent (MCP) in standby: refuse the visualizer socket entirely.
        if (!features.agent) {
            socket.destroy();
            return;
        }
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

// Build the design-flow init payload (active project + its mode + rendered svg).
async function buildInit() {
    const mode = await store.getMode();
    const d2 = await store.readDiagram();
    const { svg, error } = await renderDiagramSvg(d2);
    return { type: 'init', project: store.getCurrentProjectId(), mode, svg, renderError: error };
}

async function pushState(socket) {
    socket.send(JSON.stringify(await buildInit()));
}

// Switch the active design project and re-init every connected design client so the
// whole UI follows (single active project, demo scope). Clears the architect thread.
async function handleSelectProject(projectId) {
    const ok = await store.setCurrentProject(projectId);
    if (!ok) {
        broadcast({ type: 'error', message: 'Unknown project.' });
        return;
    }
    resetConversation();
    broadcast(await buildInit());
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

        // Design & Deploy is in standby: never invoke the LangGraph flow.
        const DESIGN_MESSAGES = ['chat', 'deploy', 'teardown', 'select-project'];
        if (!features.design && DESIGN_MESSAGES.includes(message.type)) {
            socket.send(JSON.stringify({ type: 'status', text: 'Design & Deploy is in development (standby).' }));
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
            } else if (message.type === 'select-project' && typeof message.projectId === 'string') {
                await handleSelectProject(message.projectId);
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

// Normalize the incremental changes the MCP tool uploaded into the canonical shape
// the state-merge pipeline expects: `{ op, type, id, ...resourceFields }`. Each
// change must carry a `type` and a stable `id` (the key it merges under); `op`
// defaults to 'upsert'. Entries missing type+id, or with an unknown op, are dropped.
function normalizeChanges(body) {
    if (!Array.isArray(body?.changes)) {
        return [];
    }
    return body.changes
        .map((change) => {
            if (!change || typeof change !== 'object') {
                return null;
            }
            const type = String(change.type ?? '').trim();
            const id = String(change.id ?? '').trim();
            if (!type || !id) {
                return null;
            }
            const op = change.op === 'delete' ? 'delete' : 'upsert';
            // Carry the whole detailed record through; only normalize the controls.
            return { ...change, op, type, id };
        })
        .filter(Boolean);
}

// Feature gate: short-circuits a route with 503 when its mode is disabled by config, so
// a mode in standby is truly inert (not just hidden in the UI). `isOn` is read per
// request (lazy) so flipping the env + restart is enough — no stale capture.
function requireFeature(isOn, label) {
    return (_req, res, next) => {
        if (!isOn()) {
            res.status(503).json({ error: `${label} is not available (disabled by configuration).` });
            return;
        }
        next();
    };
}
const agentGate = requireFeature(() => features.agent, 'Agent (MCP)');
const designGate = requireFeature(() => features.design, 'Design & Deploy');

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

// Ingest: the MCP tool POSTs a batch of incremental changes (upsert/delete per
// resource) for a chat. We merge them into the chat's authoritative state,
// regenerate the deployed-state D2, render it, and push it live to any web clients
// watching that chat. A brand-new session (no name yet) is auto-named from its
// architecture; an agent-supplied `project` is only a name hint.
app.post('/api/chats/:chatId/deployments', agentGate, requireToken, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }

    const changes = normalizeChanges(req.body);
    if (changes.length === 0) {
        res.status(400).json({ error: 'No changes to ingest (each change needs a type and id).' });
        return;
    }

    // An agent-supplied label is only a hint for a brand-new session; the name is
    // otherwise auto-assigned by the backend and editable from the web.
    const nameHint = visualizerStore.sanitizeName(req.body?.project) || '';

    try {
        // Is this a new session? (no name yet) — decide BEFORE the merge seeds meta.
        const priorMeta = await visualizerStore.readMeta(req.userId, chatId);
        const isNewSession = !(priorMeta.name || priorMeta.project);

        const resources = await visualizerStore.applyChanges(req.userId, chatId, changes, nameHint);

        // Auto-name a new session from its architecture when no hint was provided.
        let name = nameHint || priorMeta.name || priorMeta.project || '';
        if (isNewSession && !nameHint) {
            const suggested = await suggestSessionName(resources);
            if (suggested) {
                await visualizerStore.renameSession(req.userId, chatId, suggested);
                name = suggested;
            }
        }

        const d2 = await runStateViz(req.userId, chatId);
        const { svg, error } = await renderDiagramSvg(d2);
        broadcastToChat(req.userId, chatId, { type: 'render-svg', svg, renderError: error });
        res.json({ ok: true, chat: chatId, name, changes: changes.length, resources: resources.length, rendered: Boolean(svg) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[deployment ingest failed]', error);
        res.status(500).json({ error: message });
    }
});

// List the user's chats (newest first). The MCP uses this (with a token) for
// list_chats; the web UI hits it same-origin (no token → owner user).
app.get('/api/chats', agentGate, resolveUser, async (req, res) => {
    res.json({ chats: await visualizerStore.listChats(req.userId) });
});

// Full context for one chat: name + current deployed-state resources + current D2.
// Used by the MCP's load_chat so the agent can resume knowing what already exists
// (real IDs/ARNs) before sending its next delta of changes.
app.get('/api/chats/:chatId', agentGate, requireToken, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const [meta, state, d2] = await Promise.all([
        visualizerStore.readMeta(req.userId, chatId),
        visualizerStore.readState(req.userId, chatId),
        visualizerStore.readDiagram(req.userId, chatId)
    ]);
    res.json({ chat: chatId, name: meta.name || meta.project || '', resources: Object.values(state), d2 });
});

// Rename a session. Hit by the web UI same-origin (owner user) to override the
// auto-assigned name.
app.patch('/api/chats/:chatId', agentGate, resolveUser, async (req, res) => {
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
app.get('/api/chats/:chatId/diagram', agentGate, resolveUser, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const d2 = await visualizerStore.readDiagram(req.userId, chatId);
    const { svg, error } = await renderDiagramSvg(d2);
    res.json({ chat: chatId, svg, renderError: error });
});

// Design projects: list (newest activity first) and create. The active project is
// switched over the /ws socket (select-project), which re-inits all design clients.
app.get('/api/projects', designGate, async (_req, res) => {
    res.json({ projects: await store.listProjects(), current: store.getCurrentProjectId() });
});

app.post('/api/projects', designGate, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
        res.status(400).json({ error: 'A project name is required.' });
        return;
    }
    const project = await store.createProject(name);
    res.json(project);
});

// Token management for the web UI (the owner user of this machine).
app.get('/api/tokens', agentGate, async (_req, res) => {
    res.json({ tokens: await tokenStore.list() });
});

app.post('/api/tokens', agentGate, async (req, res) => {
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

// Public runtime config: the frontend fetches this to know which modes are available, so a
// single environment (the deploy's .env) drives both the UI and the API. Never gated.
app.get('/api/config', (_req, res) => {
    res.json({ features: { design: features.design, agent: features.agent } });
});

await store.initProject();
server.listen(PORT, () => {
    console.log(`aws-architect-web server listening on http://127.0.0.1:${PORT} (ws path /ws)`);
});
