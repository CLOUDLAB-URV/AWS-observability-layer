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
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { renderDiagramSvg } from './diagram.js';
import * as visualizerStore from './visualizerStore.js';
import * as tokenStore from './tokenStore.js';
import { features } from './features.js';
import * as auth from './auth.js';
import * as authStore from './authStore.js';
import * as admin from './admin.js';
import { getSetting } from './settingsStore.js';
import * as usageStore from './usageStore.js';
import { DEV, persistRoot, DEV_USER_ID, DEV_TOKEN } from './persistence.js';
import { runStateViz, suggestSessionName } from './agents/stateviz/index.js';
import { runExplainDiagram } from './agents/explain/index.js';

const PORT = Number(process.env.PORT || 3001);

const app = express();
app.use(express.json({ limit: '5mb' }));
// Internal login + session endpoints (/api/auth/*, /api/me). Auth is off in local dev: requests
// resolve to an ephemeral "dev" user (see auth.js / persistence.js), so no login screen appears.
auth.registerRoutes(app);
// Read-only admin API (/api/admin/*), gated on role 'admin' (granted via scripts/admin-cli.js).
admin.registerAdminRoutes(app);
const server = http.createServer(app);
// Single WebSocket endpoint: '/ws-visualizer' (live sigil updates). noServer + manual
// upgrade routing so unknown paths are refused cleanly.
const vizWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/ws-visualizer') {
        // Agent (MCP) in standby: refuse the visualizer socket entirely.
        if (!features.agent) {
            socket.destroy();
            return;
        }
        // Resolve the logged-in user from the request's cookies; reject if not authenticated
        // (when auth is on). The socket is then bound to that user's data.
        auth.resolveUser(req).then((user) => {
            if (!user) {
                socket.destroy();
                return;
            }
            vizWss.handleUpgrade(req, socket, head, (ws) => {
                ws._userId = user.userId;
                vizWss.emit('connection', ws, req);
            });
        }).catch(() => socket.destroy());
    } else {
        socket.destroy();
    }
});

// ---------------------------------------------------------------------------
// Sigils (MCP-push visualizer)
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
            const normalized = { ...change, op, type, id };
            // Per-resource deployment divergence: `deployed` must be a strict boolean (anything
            // else is dropped → inherits the sigil mode), `deploy_note` a short trimmed string.
            if (typeof change.deployed === 'boolean') {
                normalized.deployed = change.deployed;
            } else {
                delete normalized.deployed;
            }
            const note = typeof change.deploy_note === 'string' ? change.deploy_note.trim() : '';
            if (note) {
                normalized.deploy_note = note.slice(0, 300);
            } else {
                delete normalized.deploy_note;
            }
            return normalized;
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

// Bearer-token auth → resolves req.userId, or 401. Banned accounts are rejected
// here too — a ban must cut off MCP pushes, not just the web session.
async function requireToken(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const identity = await tokenStore.verify(token);
    if (!identity) {
        res.status(401).json({ error: 'Invalid or missing API token.' });
        return;
    }
    const bannedUntil = await authStore.banStatus(identity.userId);
    if (bannedUntil) {
        res.status(403).json({ error: `This account is suspended until ${new Date(bannedUntil).toUTCString()}.` });
        return;
    }
    req.userId = identity.userId;
    next();
}

// Session auth for the web UI: resolves req.userId from the login session (or the owner as a
// "dev" user when auth is disabled locally), else 401. The MCP never hits these — it uses the
// Bearer-token routes (requireToken) instead.
const requireSession = auth.requireSession;

// Dual auth for routes shared by BOTH the web UI and the MCP (e.g. GET /api/chats, which the
// browser hits same-origin with a session cookie and the MCP hits with a Bearer token). A token
// takes precedence; otherwise fall back to the login session. Either way it sets req.userId so
// the route is scoped to that user.
async function requireSessionOrToken(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
        const identity = await tokenStore.verify(token);
        if (!identity) {
            res.status(401).json({ error: 'Invalid API token.' });
            return;
        }
        req.userId = identity.userId;
        next();
        return;
    }
    return requireSession(req, res, next);
}

// Monthly LLM-token quota gate for the user-attributed AI routes (deployments ingest and
// explanation). Gate-at-entry: an in-flight call may finish past the cap, which is fine —
// the overshoot counts against next requests. Admins are exempt; skipped in local dev.
// Returns the 403 payload when over quota, or null to proceed.
async function llmQuotaBlock(userId) {
    if (DEV) {
        return null;
    }
    const user = await authStore.getUser(userId);
    if (user?.role === 'admin') {
        return null;
    }
    const cap = await getSetting('maxLlmTokensPerUserPerMonth');
    const used = (await usageStore.monthUsage(userId)).total;
    if (used < cap) {
        return null;
    }
    return { error: `Monthly AI quota reached (${used} of ${cap} tokens used). It resets on the 1st.` };
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

    const quota = await llmQuotaBlock(req.userId);
    if (quota) {
        res.status(403).json(quota);
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
    // Optional diagram mode: true = the resources are ALREADY live in AWS (direct
    // deploy), false = a design sketch (nothing created). Only meaningful for a
    // brand-new diagram; on an existing one it must match (a diagram is Design XOR
    // Live, never mixed).
    const wantDeployed = typeof req.body?.deployed === 'boolean' ? req.body.deployed : undefined;

    try {
        // Read the current mode/name BEFORE the merge seeds meta.
        const priorMeta = await visualizerStore.readMeta(req.userId, chatId);
        const exists = Boolean(priorMeta.createdAt);
        const isNewSession = !(priorMeta.name || priorMeta.project);

        // Per-user sigil cap (admin-configurable; admins exempt). Enforced only when the push
        // would create a brand-new sigil — this route is the sole way sigils come into existence.
        // Skipped in local dev: the single dev user is the machine owner (same status as admin).
        if (!exists && !DEV) {
            const pusher = await authStore.getUser(req.userId);
            if (pusher?.role !== 'admin') {
                const max = await getSetting('maxSigilsPerUser');
                const owned = (await visualizerStore.listChats(req.userId)).length;
                if (owned >= max) {
                    res.status(403).json({
                        error: `Sigil limit reached (max ${max} per account). Delete an existing sigil from the web before creating a new one.`
                    });
                    return;
                }
            }
        }

        // Enforce the "never mixed" invariant: pushing resources of the wrong mode
        // into an existing sigil is rejected.
        if (exists && wantDeployed !== undefined && wantDeployed !== priorMeta.deployed) {
            res.status(409).json({
                error: `This sigil is ${priorMeta.deployed ? 'Live (deployed to AWS)' : 'Design (not deployed)'}. ` +
                    `A sigil can't mix deployed and non-deployed resources — ` +
                    `${priorMeta.deployed ? 'report only live resources here' : 'deploy it first with deploy_sigil'}.`
            });
            return;
        }
        const deployed = exists ? priorMeta.deployed : wantDeployed === true;

        const resources = await visualizerStore.applyChanges(req.userId, chatId, changes, nameHint, deployed);

        // Auto-name a new session from its architecture when no hint was provided.
        let name = nameHint || priorMeta.name || priorMeta.project || '';
        if (isNewSession && !nameHint) {
            const suggested = await suggestSessionName(resources, req.userId);
            if (suggested) {
                await visualizerStore.renameSession(req.userId, chatId, suggested);
                name = suggested;
            }
        }

        const d2 = await runStateViz(req.userId, chatId);
        const { svg, error } = await renderDiagramSvg(d2);
        broadcastToChat(req.userId, chatId, { type: 'render-svg', svg, renderError: error });
        res.json({ ok: true, chat: chatId, name, deployed, changes: changes.length, resources: resources.length, rendered: Boolean(svg) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[deployment ingest failed]', error);
        res.status(500).json({ error: message });
    }
});

// List the user's chats (newest first). Shared route: the MCP calls it with a Bearer token
// (list_sigils, and load_sigil's lookup), the web UI calls it same-origin with a session cookie —
// so it accepts either (requireSessionOrToken) and scopes to that user.
app.get('/api/chats', agentGate, requireSessionOrToken, async (req, res) => {
    res.json({ chats: await visualizerStore.listChats(req.userId) });
});

// Full context for one chat: name + current deployed-state resources + current D2.
// Used by the MCP's load_sigil (Bearer token) so the agent can resume knowing what already exists
// (real IDs/ARNs); also by the web UI (session cookie) to power per-service tooltips and the
// resource detail panel. Dual auth so both reach it, scoped to the caller's user.
app.get('/api/chats/:chatId', agentGate, requireSessionOrToken, async (req, res) => {
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
    const sigilDeployed = meta.deployed === true;
    // Read-side backfill: resources stored before per-resource deployment state existed have
    // no `deployed` field — they inherit the sigil mode, so old sigils read as consistent.
    const resources = Object.values(state).map((r) => (
        typeof r.deployed === 'boolean' ? r : { ...r, deployed: sigilDeployed }
    ));
    res.json({ chat: chatId, name: meta.name || meta.project || '', deployed: sigilDeployed, resources, d2 });
});

// Transition a sigil from "Design" to "Live": mark it deployed and hand the caller
// the full resource spec to actually create in AWS. The MCP's deploy_sigil tool
// calls this; the coding agent then provisions with its own AWS tools and re-reports
// real ids via push_sigil. Bearer-token auth like the ingest route.
app.post('/api/chats/:chatId/deploy', agentGate, requireToken, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const [meta, state] = await Promise.all([
        visualizerStore.readMeta(req.userId, chatId),
        visualizerStore.readState(req.userId, chatId)
    ]);
    const resources = Object.values(state);
    if (!meta.createdAt || resources.length === 0) {
        res.status(404).json({ error: 'No such diagram (or it is empty) — nothing to deploy.' });
        return;
    }
    if (meta.deployed) {
        res.status(409).json({ error: 'This diagram is already Live (deployed to AWS).' });
        return;
    }
    await visualizerStore.setDeployed(req.userId, chatId, true);
    res.json({ ok: true, chat: chatId, name: meta.name || meta.project || '', deployed: true, resources });
});

// Rename a session. Hit by the web UI same-origin (owner user) to override the
// auto-assigned name.
app.patch('/api/chats/:chatId', agentGate, requireSession, async (req, res) => {
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

// Permanently delete a diagram. Web-only (owner via session cookie); the MCP token cannot
// delete diagrams. The whole chat folder (state/diagram/meta/explanation) is removed.
app.delete('/api/chats/:chatId', agentGate, requireSession, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    await visualizerStore.deleteChat(req.userId, chatId);
    res.json({ ok: true, chat: chatId });
});

// Current deployed-state diagram (SVG) for a chat.
app.get('/api/chats/:chatId/diagram', agentGate, requireSession, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const d2 = await visualizerStore.readDiagram(req.userId, chatId);
    const { svg, error } = await renderDiagramSvg(d2);
    res.json({ chat: chatId, svg, renderError: error });
});

// Read the saved component-by-component explanation for a chat (no LLM call). Reports
// `outdated: true` when the diagram changed since the explanation was generated so the
// web can prompt the user to update it. Dual auth to mirror GET /api/chats/:chatId.
app.get('/api/chats/:chatId/explanation', agentGate, requireSessionOrToken, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const [explanation, meta] = await Promise.all([
        visualizerStore.readExplanation(req.userId, chatId),
        visualizerStore.readMeta(req.userId, chatId)
    ]);
    if (!explanation) {
        res.json({ chat: chatId, markdown: '', generatedAt: null, outdated: false });
        return;
    }
    res.json({
        chat: chatId,
        markdown: explanation.markdown,
        generatedAt: explanation.generatedAt || null,
        outdated: explanation.basedOnUpdatedAt !== (meta.updatedAt || null)
    });
});

// (Re)generate the explanation for a chat. Evolves the previous explanation (feeding
// it back in) so a diagram change yields a minimal edit rather than a brand-new text.
// Web-only (session cookie); the user triggers it explicitly from the UI.
app.post('/api/chats/:chatId/explanation', agentGate, requireSession, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const [meta, state] = await Promise.all([
        visualizerStore.readMeta(req.userId, chatId),
        visualizerStore.readState(req.userId, chatId)
    ]);
    if (!meta.createdAt || Object.keys(state).length === 0) {
        res.status(404).json({ error: 'No such diagram (or it is empty) — nothing to explain.' });
        return;
    }
    const quota = await llmQuotaBlock(req.userId);
    if (quota) {
        res.status(403).json(quota);
        return;
    }
    try {
        const payload = await runExplainDiagram(req.userId, chatId);
        if (!payload) {
            res.status(502).json({ error: 'Could not generate an explanation. Please try again.' });
            return;
        }
        res.json({ chat: chatId, markdown: payload.markdown, generatedAt: payload.generatedAt, outdated: false });
    } catch (err) {
        console.error('[explain] generation failed', err);
        res.status(502).json({ error: 'Could not generate an explanation. Please try again.' });
    }
});

// Token management for the web UI, scoped to the logged-in user (the MCP uses these tokens to
// push deployments into that user's space).
app.get('/api/tokens', agentGate, requireSession, async (req, res) => {
    // Local dev: no generated tokens — expose the fixed env token + local URL so the web can show a
    // ready-to-paste MCP config that targets this local server.
    if (DEV) {
        res.json({ dev: true, devToken: DEV_TOKEN, visualizerUrl: `http://localhost:${PORT}`, tokens: [] });
        return;
    }
    res.json({ tokens: await tokenStore.list(req.userId) });
});

app.post('/api/tokens', agentGate, requireSession, async (req, res) => {
    if (DEV) {
        res.status(403).json({ error: 'Token generation is disabled in local dev — the MCP uses the DEV_VISUALIZER_TOKEN env var.' });
        return;
    }
    const result = await tokenStore.create(req.userId, String(req.body?.label || ''), {
        isAdmin: req.user?.role === 'admin'
    });
    if (result.error === 'limit') {
        res.status(409).json({ error: `Token limit reached (max ${result.max}). Revoke one first.`, max: result.max });
        return;
    }
    // The full token is returned exactly once so the user can copy it into the MCP config.
    res.json({ token: result.token, id: result.id });
});

// Revoke one of the user's tokens by its non-secret id.
app.delete('/api/tokens/:id', agentGate, requireSession, async (req, res) => {
    if (DEV) {
        res.status(403).json({ error: 'Token management is disabled in local dev.' });
        return;
    }
    const ok = await tokenStore.revoke(req.userId, req.params.id);
    if (!ok) {
        res.status(404).json({ error: 'Token not found.' });
        return;
    }
    res.json({ ok: true });
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
            // socket._userId was bound to the logged-in user at upgrade time.
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

// Lab-demo installer script — gated behind login so it's only reachable from inside the app
// (Connect agent panel), never a guessable public URL. Holds a short-lived Vertex AI Express-mode
// key baked in for the demo; not meant to stay published long-term.
const DEMO_SCRIPT_PATH = fileURLToPath(new URL('./assets/opencode-vertex-demo.sh', import.meta.url));
app.get('/api/opencode-vertex-demo.sh', requireSession, (_req, res) => {
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="opencode-vertex-demo.sh"');
    res.sendFile(DEMO_SCRIPT_PATH);
});

// Public runtime config: the frontend fetches this to know whether the app is available, so a
// single environment (the deploy's .env) drives both the UI and the API. Never gated.
app.get('/api/config', (_req, res) => {
    res.json({ features: { agent: features.agent } });
});

server.listen(PORT, () => {
    console.log(`sigilum server listening on http://127.0.0.1:${PORT} (ws path /ws-visualizer)`);
    if (DEV && !auth.authEnabled()) {
        console.log(`[dev] login disabled — fixed local user ${DEV_USER_ID}; data persists in ${persistRoot()} (durable)`);
        console.log(`[dev] MCP token: set SIGILUM_TOKEN=${DEV_TOKEN} SIGILUM_URL=http://localhost:${PORT}`);
    }
});
