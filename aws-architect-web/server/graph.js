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
import { renderDiagramSvg } from './diagram.js';
import * as store from './projectStore.js';

// Teardown orchestration: re-invoke the teardown agent up to N times, waiting
// (backoff) between attempts so resources in a transitional DELETING state — or
// blocked by a dependency that is itself being deleted — get a chance to settle.
const TEARDOWN_MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const teardownBackoffMs = (attempt) => Math.min(60000, attempt * 15000);

// Single shared session (demo scope): one running conversation for the architect.
// Kept at module scope — same lifetime as the previous index.js implementation —
// instead of a checkpointer, to avoid serializing Anthropic content blocks.
const architectHistory = [];

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

// Reconciler agent: reconciles the diagram with the real deployed state, and
// flips to deployed mode after a deploy.
async function reconcilerNode(state, config) {
    const { emit } = config.configurable;

    const merged = await runReconciler(emit);

    if (state.trigger === 'deploy') {
        if (merged !== null) {
            await store.setMode('deployed');
            emit({ type: 'mode', mode: 'deployed' });
            emit({ type: 'status', text: 'Deployment complete — now in deployed mode.' });
        } else {
            // Queue was empty — no resources were created (credentials likely failed)
            emit({ type: 'error', message: 'Deployment failed: no AWS resources were created. Check your credentials (run: aws sso login) and try again.' });
            emit({ type: 'status', text: '' });
        }
    } else {
        emit({ type: 'status', text: 'Done.' });
    }

    return { diagramChanged: merged !== null };
}

// Teardown agent: destroys every AWS resource of the current architecture.
// Re-invokes the agent up to TEARDOWN_MAX_ATTEMPTS times with backoff waits so
// DELETING/dependency states settle. On full success → back to preview + clean
// state; on partial → stay deployed and report what could not be deleted.
async function teardownNode(_state, config) {
    const { emit } = config.configurable;

    // Snapshot inputs once, before the agent's deletes append to the workflow log.
    const [diagram, deploymentLog] = await Promise.all([store.readDiagram(), store.readWorkflow()]);

    let remaining = null;
    for (let attempt = 1; attempt <= TEARDOWN_MAX_ATTEMPTS; attempt++) {
        emit({ type: 'status', text: `Tearing down AWS resources (attempt ${attempt}/${TEARDOWN_MAX_ATTEMPTS})…` });

        const status = await runTeardownAgent({ diagram, deploymentLog, previousRemaining: remaining }, emit);

        if (status.complete) {
            remaining = [];
            break;
        }
        remaining = status.remaining;

        if (attempt < TEARDOWN_MAX_ATTEMPTS) {
            emit({
                type: 'status',
                text: `${remaining.length} resource(s) not yet deletable — waiting before retry…`
            });
            await sleep(teardownBackoffMs(attempt));
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
            `Teardown incomplete after ${TEARDOWN_MAX_ATTEMPTS} attempts. Still present in AWS:\n${list}\n` +
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
