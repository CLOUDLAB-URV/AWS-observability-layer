#!/usr/bin/env node
'use strict';

// Sigils load test — N concurrent users pushing deployed-state every M seconds.
//
// Drives the exact flow a real MCP agent uses: each virtual user has its own
// account + MCP token and POSTs incremental changes to
// /api/chats/:chatId/deployments, which makes the server run Gemini (stateviz)
// per push. That's the AI-quota-sensitive path this test exists to measure.
//
// ALWAYS run against a scratch backend (never :3001 dev, never production):
//
//   cd server
//   NODE_ENV=production PORT=3105 MAX_USERS=200 \
//   PERSIST_DIR=/tmp/loadtest-persist AUTH_PERSIST_DIR=/tmp/loadtest-persist/auth \
//   npm start
//
//   node loadtest/run.js --base http://127.0.0.1:3105 --users 20 --interval 30 --duration 300
//
// See loadtest/README.md for the full guide and flag reference.

import { parseArgs } from 'node:util';
import { provisionUsers } from './lib/setup.js';
import { buildPushBody, buildNoAiBody } from './lib/payloads.js';
import { Metrics, renderReport } from './lib/metrics.js';

const HELP = `
Sigils load test — concurrent users pushing deployed-state via the MCP API.

Usage:
  node loadtest/run.js [flags]

Flags:
  --base <url>        Target server (default http://127.0.0.1:3105)
  --users <n>         Concurrent virtual users (default 20)
  --interval <sec>    Seconds between pushes per user (default 30)
  --duration <sec>    Total run time (default 300)
  --no-ai             Dry run: pushes that skip the Gemini calls entirely
                      (validates auth/ingest/render under load without quota)
  --help              This help

Exit codes: 0 = all requests succeeded · 1 = failures · 2 = setup/usage error
`;

function parseFlags() {
    const { values } = parseArgs({
        options: {
            base: { type: 'string', default: 'http://127.0.0.1:3105' },
            users: { type: 'string', default: '20' },
            interval: { type: 'string', default: '30' },
            duration: { type: 'string', default: '300' },
            'no-ai': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false }
        }
    });
    if (values.help) {
        console.log(HELP);
        process.exit(0);
    }
    const num = (name) => {
        const n = Number.parseInt(values[name], 10);
        if (!Number.isFinite(n) || n <= 0) {
            console.error(`--${name} must be a positive integer`);
            process.exit(2);
        }
        return n;
    };
    return {
        base: values.base.replace(/\/+$/, ''),
        users: num('users'),
        interval: num('interval'),
        duration: num('duration'),
        noAi: values['no-ai']
    };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One measured push. Requests are given a generous timeout: under saturation the
// server intentionally queues LLM calls (LLM_MAX_CONCURRENT) instead of failing.
async function push(base, user, iteration, noAi, metrics) {
    const body = noAi ? buildNoAiBody(user.index, iteration) : buildPushBody(user.index, iteration);
    const started = Date.now();
    try {
        const res = await fetch(`${base}/api/chats/${user.chatId}/deployments`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${user.token}`
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180_000)
        });
        const ms = Date.now() - started;
        const ok = res.ok;
        metrics.record({ ok, status: res.status, ms });
        if (!ok) {
            const text = (await res.text()).slice(0, 300);
            console.error(`  ✗ u${user.index} iter ${iteration}: HTTP ${res.status} ${text}`);
        }
    } catch (error) {
        metrics.record({ ok: false, status: 0, ms: Date.now() - started, error: String(error) });
        console.error(`  ✗ u${user.index} iter ${iteration}: ${error?.message ?? error}`);
    }
}

// One virtual user's life: random initial offset (desynchronizes the fleet),
// then a push every `interval` seconds until the deadline.
async function virtualUser(cfg, user, deadline, metrics) {
    await sleep(Math.random() * cfg.interval * 1000);
    for (let iteration = 0; Date.now() < deadline; iteration++) {
        const startedAt = Date.now();
        await push(cfg.base, user, iteration, cfg.noAi, metrics);
        const nextAt = startedAt + cfg.interval * 1000;
        const wait = nextAt - Date.now();
        if (wait > 0 && Date.now() + wait < deadline) {
            await sleep(wait);
        } else if (wait <= 0) {
            continue; // the push took longer than the interval — go again immediately
        } else {
            break;
        }
    }
}

async function main() {
    const cfg = parseFlags();

    // Refuse the two targets this must never hit.
    if (/:3001\b/.test(cfg.base) || /sigilum\.cloud/i.test(cfg.base)) {
        console.error(`Refusing to run against ${cfg.base} — use a scratch backend (see loadtest/README.md).`);
        return 2;
    }

    const health = await fetch(`${cfg.base}/health`).catch(() => null);
    if (!health?.ok) {
        console.error(`No server responding at ${cfg.base} — start the scratch backend first (see header).`);
        return 2;
    }

    console.log(`Sigils load test → ${cfg.base}`);
    console.log(`  ${cfg.users} users · 1 push every ${cfg.interval}s each · ${cfg.duration}s total` +
        `${cfg.noAi ? ' · NO-AI dry run' : ' · real Gemini calls (1 per push)'}\n`);

    console.log('Provisioning users (register → verify → MCP token)…');
    const { users } = await provisionUsers(cfg.base, cfg.users);

    const metrics = new Metrics();
    const deadline = Date.now() + cfg.duration * 1000;

    const progress = setInterval(() => {
        const s = metrics.summary();
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        console.log(`  … ${left}s left${left === 0 ? ' (draining in-flight pushes)' : ''} · ${s.requests} pushes (${s.failed} failed) · p95 ${Math.round(s.p95)}ms`);
    }, 15_000);
    progress.unref();

    await Promise.all(users.map((user) => virtualUser(cfg, user, deadline, metrics)));
    clearInterval(progress);

    console.log(renderReport(metrics, {
        label: `POST /api/chats/:id/deployments — ${cfg.users}u/${cfg.interval}s${cfg.noAi ? ' (no-ai)' : ''}`
    }));
    return metrics.failCount === 0 ? 0 : 1;
}

main().then(
    (code) => { process.exitCode = code; },
    (error) => {
        console.error(error?.message ?? error);
        process.exitCode = 2;
    }
);
