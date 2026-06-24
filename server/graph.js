'use strict';

// Multi-agent orchestration as an explicit LangGraph state graph.
//
//   START → router ─┬─(chat, preview mode)──→ architect ──────────────────┐
//                   ├─(deploy | deployed mode)→ aws → reconciler ──────────┤→ render → END
//                   └─(teardown)─────────────→ teardown ──────────────────┘
//
// The router is a pure, no-LLM node: it inspects the user's mode + trigger and
// routes to the architect (diagram-only) agent, the aws agent, or the teardown
// agent. Each node calls Gemini directly (streaming + MCP tools live in the
// agents), so the graph only owns sequencing — not the model calls.

import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { runArchitectTurn } from './agents/architect/index.js';
import { runAwsAgent } from './agents/aws/index.js';
import { runReconciler } from './agents/reconciler/index.js';
import { runTeardownAgent } from './agents/teardown/index.js';
import { successfulCreations } from './agents/shared/deployLog.js';
import { renderDiagramSvg } from './diagram.js';
import * as store from './projectStore.js';

// Teardown orchestration: re-invoke the teardown agent up to N times, waiting
// (backoff) between attempts so resources in a transitional DELETING state — or
// blocked by a dependency that is itself being deleted — get a chance to settle.
// Bounded further by a no-progress check (stop when an attempt changes nothing).
const TEARDOWN_MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const teardownBackoffMs = (attempt) => Math.min(30000, attempt * 15000);

// A stable signature of the "remaining" set, to detect attempts that made no
// progress (same resources still present) so we stop retrying the impossible.
const remainingSignature = (remaining) =>
    (Array.isArray(remaining) ? remaining : [])
        .map((r) => String(r?.resource ?? ''))
        .sort()
        .join('|');

// Waiting + retrying only helps when something is still settling: a transient
// DELETING state, or a dependency that is itself being torn down. Permanent
// blockers (permission denied, manual prerequisites) won't clear on their own —
// retrying just burns a full agent run + a backoff sleep for nothing.
const TRANSIENT_REASON_RE =
    /DELETING|DependencyViolation|depend|in use|InvalidState|in progress|being deleted|try again|not yet/i;
const hasTransientReason = (remaining) =>
    (Array.isArray(remaining) ? remaining : []).some((r) => TRANSIENT_REASON_RE.test(String(r?.reason ?? '')));

// One running conversation for the architect, kept at module scope (instead of a
// checkpointer, to avoid serializing Anthropic content blocks). It is per active
// project: switching projects clears it via resetConversation() so each design has
// its own fresh chat thread.
const architectHistory = [];

// Clear the in-memory architect conversation. Called when the active design project
// switches so the new project starts a clean thread (its diagram is the persisted
// state; the chat log is ephemeral and reset client-side too).
export function resetConversation() {
    architectHistory.length = 0;
}

const DEPLOY_TASK =
    'Deploy the architecture described in the current D2 diagram into AWS. Create every resource the diagram represents, using sensible defaults and free-tier-friendly sizes where the diagram does not specify them.';

// Channels carried through one run. `emit` is passed via config (a side effect,
// not state). `diagramChanged` signals the render node to repaint.
const GraphState = Annotation.Root({
    trigger: Annotation(),         // 'chat' | 'deploy'
    mode: Annotation(),            // 'preview' | 'deployed' (mode at run start)
    text: Annotation(),            // user message (chat trigger only)
    diagramChanged: Annotation()   // set by the agent nodes, read by render
});

// --- Routing: no LLM, just the user's mode + trigger ------------------------
function route(state) {
    if (state.trigger === 'teardown') {
        return 'teardown';
    }
    if (state.trigger === 'deploy') {
        return 'aws';
    }
    return state.mode === 'preview' ? 'architect' : 'aws';
}

// --- Nodes ------------------------------------------------------------------

// Pure pass-through; the routing decision happens on the conditional edge.
function routerNode() {
    return {};
}

// Architect agent: chat iterates the D2 diagram (Haiku). Nothing touches AWS.
async function architectNode(state, config) {
    const { emit } = config.configurable;
    const d2 = await runArchitectTurn(architectHistory, state.text, emit);
    emit({ type: 'chat-done' });
    return { diagramChanged: d2 !== null };
}

// AWS agent: executes the diagram (deploy) or a free-form prompt (deployed-mode
// chat) against real AWS via the MCP tools (Sonnet).
async function awsNode(state, config) {
    const { emit } = config.configurable;

    let task;
    if (state.trigger === 'deploy') {
        emit({ type: 'status', text: 'Deploying architecture to AWS…' });
        task = DEPLOY_TASK;
    } else {
        task = state.text;
    }

    await runAwsAgent(task, emit);
    emit({ type: 'chat-done' });
    return {};
}

// Reconciler agent: keeps the user's exact pre-deploy diagram, marking only the
// resources that failed to deploy. Sets the mode from the deploy outcome:
//   'deployed' (all up) | 'partial' (some failed → retry or tear down) | 'none'.
async function reconcilerNode(state, config) {
    const { emit } = config.configurable;

    const { deployState, diagramChanged } = await runReconciler(emit);

    if (deployState === 'none') {
        if (state.trigger === 'deploy') {
            // Nothing was created (every call errored / empty) — credentials likely failed.
            emit({ type: 'error', message: 'Deployment failed: no AWS resources were created. Check your credentials (run: aws sso login) and try again.' });
            emit({ type: 'status', text: '' });
        } else {
            emit({ type: 'status', text: 'Done.' });
        }
        return { diagramChanged };
    }

    // 'deployed' or 'partial': reflect the real state in the mode badge.
    await store.setMode(deployState);
    emit({ type: 'mode', mode: deployState });
    if (deployState === 'partial') {
        emit({ type: 'status', text: 'Partially deployed — some resources could not be created. Retry deploy or tear down.' });
    } else {
        emit({ type: 'status', text: 'Deployment complete — now in deployed mode.' });
    }

    return { diagramChanged };
}

// Teardown agent: destroys every AWS resource of the current architecture.
// Re-invokes the agent up to TEARDOWN_MAX_ATTEMPTS times with backoff waits so
// DELETING/dependency states settle. On full success → back to preview + clean
// state; on partial → stay deployed and report what could not be deleted.
async function teardownNode(_state, config) {
    const { emit } = config.configurable;

    // Snapshot inputs once, before the agent's deletes append to the workflow log.
    const [diagram, fullLog] = await Promise.all([store.readDiagram(), store.readWorkflow()]);

    // Only successfully-created resources can exist in AWS. Filtering the log to
    // these keeps the agent from chasing phantom (failed/never-created) resources.
    const deploymentLog = successfulCreations(fullLog);

    let remaining = null;

    // Deterministic short-circuit: nothing was ever created → nothing to delete.
    if (deploymentLog.length === 0) {
        emit({ type: 'status', text: 'Nothing was deployed — no AWS resources to delete.' });
        remaining = [];
    } else {
        let prevSignature = null;
        for (let attempt = 1; attempt <= TEARDOWN_MAX_ATTEMPTS; attempt++) {
            emit({ type: 'status', text: `Tearing down AWS resources (attempt ${attempt}/${TEARDOWN_MAX_ATTEMPTS})…` });

            const status = await runTeardownAgent({ diagram, deploymentLog, previousRemaining: remaining }, emit);

            if (status.complete) {
                remaining = [];
                break;
            }
            remaining = status.remaining;

            // No progress since the last attempt (same resources still present) →
            // further identical retries won't help; stop and report what's left.
            const signature = remainingSignature(remaining);
            if (signature === prevSignature) {
                emit({ type: 'status', text: 'No further progress possible — stopping retries.' });
                break;
            }
            prevSignature = signature;

            // Only wait + retry when something is actually settling. If every
            // remaining blocker is permanent (permission/manual), a retry can't
            // help — stop now instead of sleeping and re-running the agent.
            if (!hasTransientReason(remaining)) {
                emit({ type: 'status', text: 'Remaining resources are blocked permanently — stopping retries.' });
                break;
            }

            if (attempt < TEARDOWN_MAX_ATTEMPTS) {
                emit({
                    type: 'status',
                    text: `${remaining.length} resource(s) not yet deletable — waiting before retry…`
                });
                await sleep(teardownBackoffMs(attempt));
            }
        }
    }

    emit({ type: 'chat-done' });

    if (!remaining || remaining.length === 0) {
        await store.setMode('preview');
        await Promise.all([store.writeDiagram(''), store.clearQueue(), store.clearWorkflow()]);
        emit({ type: 'mode', mode: 'preview' });
        emit({ type: 'status', text: 'Teardown complete — all resources deleted, back to preview mode.' });
        return { diagramChanged: true }; // render an empty diagram
    }

    // Partial: stay in deployed mode, report what is left. Clear the queue so stale
    // delete-ops don't feed a later reconcile.
    await store.clearQueue();
    const list = remaining.map((r) => `• ${r.resource} — ${r.reason}`).join('\n');
    emit({
        type: 'error',
        message:
            `Teardown incomplete. Still present in AWS:\n${list}\n` +
            'Re-run "Tear down" to retry.'
    });
    return { diagramChanged: false };
}

// Repaints the diagram if anything changed it this run.
async function renderNode(state, config) {
    const { emit } = config.configurable;
    if (!state.diagramChanged) {
        return {};
    }
    const d2 = await store.readDiagram();
    const { svg, error } = await renderDiagramSvg(d2);
    emit(error ? { type: 'render-error', error } : { type: 'render-svg', svg });
    return {};
}

// --- Graph wiring -----------------------------------------------------------
const app = new StateGraph(GraphState)
    .addNode('router', routerNode)
    .addNode('architect', architectNode)
    .addNode('aws', awsNode)
    .addNode('reconciler', reconcilerNode)
    .addNode('teardown', teardownNode)
    .addNode('render', renderNode)
    .addEdge(START, 'router')
    .addConditionalEdges('router', route, { architect: 'architect', aws: 'aws', teardown: 'teardown' })
    .addEdge('architect', 'render')
    .addEdge('aws', 'reconciler')
    .addEdge('reconciler', 'render')
    .addEdge('teardown', 'render')
    .addEdge('render', END)
    .compile();

// Runs one turn through the graph. `trigger` is 'chat' | 'deploy' | 'teardown';
// `emit` is the WebSocket broadcast fn. Returns when the flow (incl. render) is done.
export async function runFlow({ trigger, mode, text = '' }, emit) {
    await app.invoke(
        { trigger, mode, text, diagramChanged: false },
        { configurable: { emit } }
    );
}
