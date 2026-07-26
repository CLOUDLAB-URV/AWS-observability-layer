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
import { renderDeployedDiagram } from './diagram.js';
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
import { runAskDiagram } from './agents/ask/index.js';
import { normalizeChanges } from './normalizeChanges.js';

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
// the diagram Ask chat). Gate-at-entry: an in-flight call may finish past the cap, which is fine —
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

// The logged-in user's own consumption, for the Options → Usage tab: LLM tokens this month
// against the monthly cap, and sigil count against the per-user cap.
app.get('/api/me/usage', requireSession, async (req, res) => {
    const [llm, llmLimit, chats, sigilLimit] = await Promise.all([
        usageStore.monthUsage(req.userId),
        getSetting('maxLlmTokensPerUserPerMonth'),
        visualizerStore.listChats(req.userId),
        getSetting('maxSigilsPerUser')
    ]);
    res.json({ llm, llmLimit, sigils: chats.length, sigilLimit });
});

// Per-user sigil cap (admin-configurable; admins exempt; skipped in DEV — the single dev
// user is the machine owner, same status as admin). Shared by every route that can bring
// a brand-new sigil into existence: the implicit-create path in /deployments below, and
// the explicit POST /api/chats route. Returns an error string, or null if creation is allowed.
async function sigilCapBlock(userId) {
    if (DEV) {
        return null;
    }
    const pusher = await authStore.getUser(userId);
    if (pusher?.role === 'admin') {
        return null;
    }
    const max = await getSetting('maxSigilsPerUser');
    const owned = (await visualizerStore.listChats(userId)).length;
    if (owned >= max) {
        return `Sigil limit reached (max ${max} per account). Delete an existing sigil from the web before creating a new one.`;
    }
    return null;
}

// Explicitly create a brand-new, empty, named sigil. The id is minted here (server-side,
// visualizerStore.createChat) — this is the ONLY route whose purpose is to mint a new
// chatId. Kept deliberately minimal (name + mode only): populating it with resources is a
// separate, immediately-following call to /deployments with the returned chatId, reusing
// that route's validation/rendering/broadcast instead of duplicating it here.
app.post('/api/chats', agentGate, requireToken, async (req, res) => {
    const capError = await sigilCapBlock(req.userId);
    if (capError) {
        res.status(403).json({ error: capError });
        return;
    }
    const nameHint = visualizerStore.sanitizeName(req.body?.name) || '';
    const initialDeployed = req.body?.deployed === true;
    try {
        const { chatId, name } = await visualizerStore.createChat(req.userId, nameHint, initialDeployed);
        res.json({ chatId, name, deployed: initialDeployed });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[chat create failed]', error);
        res.status(500).json({ error: message });
    }
});

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

        // Enforced only when the push would create a brand-new sigil (this route is also
        // reachable directly, e.g. a first push to a pinned SIGILUM_SIGIL_ID, not just via
        // POST /api/chats).
        if (!exists) {
            const capError = await sigilCapBlock(req.userId);
            if (capError) {
                res.status(403).json({ error: capError });
                return;
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

        // Name the new diagram. Diagrams are identified by their NAME (not the id), so a name is
        // unique per user: an explicit hint is de-duplicated, and the AI auto-namer is asked to
        // retry when it proposes a name that's already taken, with a numeric-suffix fallback so a
        // push never fails just because a good name collided.
        let name = priorMeta.name || priorMeta.project || '';
        if (isNewSession) {
            if (nameHint) {
                name = await visualizerStore.uniqueName(req.userId, nameHint, chatId);
            } else {
                const avoid = [];
                let picked = '';
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    const suggested = await suggestSessionName(resources, req.userId, avoid);
                    if (!suggested) break;
                    if (!(await visualizerStore.nameConflict(req.userId, suggested, chatId))) {
                        picked = suggested;
                        break;
                    }
                    avoid.push(suggested); // tell the next attempt this one is taken
                }
                name = picked
                    || await visualizerStore.uniqueName(req.userId, avoid[avoid.length - 1] || 'Untitled sigil', chatId);
            }
            await visualizerStore.renameSession(req.userId, chatId, name);
        }

        const d2 = await runStateViz(req.userId, chatId);
        const { svg, svgActionSteps, hasSteps, error } = await renderDeployedDiagram(d2);
        broadcastToChat(req.userId, chatId, { type: 'render-svg', svg, svgActionSteps, hasSteps, renderError: error });
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

// Tear down a Live sigil back to "Design": the inverse of /deploy. The MCP's teardown_sigil
// tool calls this AFTER the coding agent has destroyed the real AWS resources with its own tools
// (Sigilum has no AWS access — it only records the teardown). It flips the sigil to Design and
// marks EVERY resource undeployed while KEEPING them all (a teardown never deletes a node), so the
// user can review or redeploy later. Bearer-token auth like the deploy route.
app.post('/api/chats/:chatId/teardown', agentGate, requireToken, async (req, res) => {
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
        res.status(404).json({ error: 'No such diagram (or it is empty) — nothing to tear down.' });
        return;
    }
    if (!meta.deployed) {
        res.status(409).json({ error: 'This diagram is already Design (not deployed) — nothing to tear down.' });
        return;
    }
    // Flip Design mode + mark every resource undeployed. This is the authoritative part and is
    // persisted before we regenerate, so a diagram-regen failure never loses the teardown.
    const resources = await visualizerStore.tearDown(req.userId, chatId);
    // Best-effort re-render so the open web reflects Design immediately; regen may fail (e.g. the
    // LLM is unreachable) but the state flip already landed, so don't fail the request over it.
    try {
        const d2 = await runStateViz(req.userId, chatId);
        const { svg, svgActionSteps, hasSteps, error } = await renderDeployedDiagram(d2);
        broadcastToChat(req.userId, chatId, { type: 'render-svg', svg, svgActionSteps, hasSteps, renderError: error });
    } catch (error) {
        console.error('[teardown re-render failed]', error);
    }
    res.json({ ok: true, chat: chatId, name: meta.name || meta.project || '', deployed: false, resources });
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
    // Names identify diagrams, so they're unique per user. A manual rename to a name another
    // diagram already uses is refused (the web surfaces this to the user) — it is not silently
    // disambiguated the way the AI auto-namer is.
    if (await visualizerStore.nameConflict(req.userId, name, chatId)) {
        res.status(409).json({ error: `You already have a diagram named "${name}". Pick a different name.` });
        return;
    }
    const meta = await visualizerStore.renameSession(req.userId, chatId, name);
    res.json({ chat: chatId, name: meta.name });
});

// Permanently delete a diagram. Web-only (owner via session cookie); the MCP token cannot
// delete diagrams. The whole chat folder (state/diagram/meta/ask chat) is removed.
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
    const { svg, svgActionSteps, hasSteps, error } = await renderDeployedDiagram(d2);
    res.json({ chat: chatId, svg, svgActionSteps, hasSteps, renderError: error });
});

// The persisted diagram Q&A ("Ask") history for a chat. Web-only — the chat is a UI
// feature; the MCP token has no business reading it.
app.get('/api/chats/:chatId/ask', agentGate, requireSession, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const messages = await visualizerStore.readAskChat(req.userId, chatId);
    res.json({ chat: chatId, messages });
});

// Clear the Ask conversation for a chat (the panel's "Clear" button).
app.delete('/api/chats/:chatId/ask', agentGate, requireSession, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    await visualizerStore.writeAskChat(req.userId, chatId, []);
    res.json({ ok: true, chat: chatId });
});

// Ask a question about the diagram. Strictly informative: this route reads the sigil's
// CURRENT state (fresh on every question) and streams the model's answer back as plain
// text chunks; it never mutates the sigil. The conversation history is server-side
// (chat.json) — any history in the request body is ignored, so it can't be forged.
app.post('/api/chats/:chatId/ask', agentGate, requireSession, async (req, res) => {
    const chatId = visualizerStore.sanitizeChatId(req.params.chatId);
    if (!chatId) {
        res.status(400).json({ error: 'Invalid chat id.' });
        return;
    }
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) {
        res.status(400).json({ error: 'A non-empty question is required.' });
        return;
    }
    if (question.length > 2000) {
        res.status(400).json({ error: 'Question too long (max 2000 characters).' });
        return;
    }
    const [meta, state] = await Promise.all([
        visualizerStore.readMeta(req.userId, chatId),
        visualizerStore.readState(req.userId, chatId)
    ]);
    if (!meta.createdAt || Object.keys(state).length === 0) {
        res.status(404).json({ error: 'No such diagram (or it is empty) — nothing to ask about.' });
        return;
    }
    const quota = await llmQuotaBlock(req.userId);
    if (quota) {
        res.status(403).json(quota);
        return;
    }

    const history = await visualizerStore.readAskChat(req.userId, chatId);
    // Stream the answer as chunked plain text. Headers are only committed on the first
    // delta (res.write), so a failure BEFORE any output can still return a JSON error.
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no'); // don't let a proxy buffer the stream
    try {
        const answer = await runAskDiagram(req.userId, chatId, question, history, {
            onText: (delta) => res.write(delta)
        });
        if (!answer) {
            if (!res.headersSent) {
                res.status(502).json({ error: 'Could not answer that. Please try again.' });
            }
            res.end();
            return;
        }
        const at = new Date().toISOString();
        await visualizerStore.writeAskChat(req.userId, chatId, [
            ...history,
            { role: 'user', text: question, at },
            { role: 'assistant', text: answer, at }
        ]);
    } catch (err) {
        console.error('[ask] failed', err);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Could not answer that. Please try again.' });
            return;
        }
    }
    res.end();
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
            const { svg, svgActionSteps, hasSteps, error } = await renderDeployedDiagram(d2);
            socket.send(JSON.stringify({ type: 'init', chat: chatId, svg, svgActionSteps, hasSteps, renderError: error }));
        }
    });
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
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
