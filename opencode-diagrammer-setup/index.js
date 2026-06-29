#!/usr/bin/env node
'use strict';

// One-shot setup for using the diagram-state-visualizer MCP with opencode.
//
//   VISUALIZER_TOKEN=viz_… npx -y @apozo/opencode-diagrammer-setup
//
// What it does (Linux):
//   1. Checks the token (from VISUALIZER_TOKEN or --token).
//   2. Checks whether `opencode` is installed; if not, asks to install it (npm -g, with the
//      official curl installer as fallback) and continues — or stops if you decline.
//   3. Idempotently adds the `diagram-state-visualizer` MCP entry to ~/.config/opencode/opencode.json.
//      Re-running only refreshes the token; everything else is left exactly as it is.
//
// The token is never printed.

import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { applyOpencodeConfig, parseArgs, SERVER_KEY } from './config.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'opencode.json');

function log(msg = '') { process.stdout.write(`${msg}\n`); }
function err(msg = '') { process.stderr.write(`${msg}\n`); }

// True if `opencode` resolves and runs. Errors (ENOENT) → not installed.
function isOpencodeInstalled() {
    const r = spawnSync('opencode', ['--version'], { stdio: 'ignore' });
    return !r.error && r.status === 0;
}

// Ask a yes/no question on the TTY. Resolves false when stdin isn't interactive (e.g. piped),
// so unattended runs never hang waiting on input.
function confirm(question) {
    if (!process.stdin.isTTY) {
        return Promise.resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${question} `, (answer) => {
            rl.close();
            resolve(/^y(es)?$/i.test(String(answer).trim()));
        });
    });
}

// Install opencode: try npm global first, fall back to the official installer script.
function installOpencode() {
    log('Installing opencode via npm (npm install -g opencode-ai)…');
    const npm = spawnSync('npm', ['install', '-g', 'opencode-ai'], { stdio: 'inherit' });
    if (!npm.error && npm.status === 0) {
        return true;
    }
    err('npm install failed (often a permissions issue) — trying the official installer…');
    const curl = spawnSync('bash', ['-c', 'curl -fsSL https://opencode.ai/install | bash'], { stdio: 'inherit' });
    return !curl.error && curl.status === 0;
}

// Read + parse the existing config. Returns { config } ({} when the file is missing), or
// { error } when the file exists but isn't valid JSON (so we never clobber it).
function readConfig() {
    let raw;
    try {
        raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    } catch {
        return { config: {} };
    }
    if (!raw.trim()) {
        return { config: {} };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { error: 'is not a JSON object' };
        }
        return { config: parsed };
    } catch (e) {
        return { error: e.message };
    }
}

export async function runSetupOpencode(argv) {
    let opts;
    try {
        opts = parseArgs(argv, process.env);
    } catch (e) {
        err(`✖ ${e.message}`);
        err('  Generate a token in the web UI → Deployed state → Connect agent, then run:');
        err('    VISUALIZER_TOKEN=viz_your_token npx -y @apozo/opencode-diagrammer-setup');
        return 1;
    }

    // 1) opencode present?
    if (!isOpencodeInstalled()) {
        log('opencode is not installed.');
        const ok = opts.yes || await confirm('Install it now? [y/N]');
        if (!ok) {
            err('✖ Setup stopped. Install opencode (https://opencode.ai) and run this again.');
            return 1;
        }
        if (!installOpencode()) {
            err('✖ Could not install opencode automatically.');
            err('  Install it manually (https://opencode.ai/docs) and run this again.');
            return 1;
        }
        if (!isOpencodeInstalled()) {
            err('✖ opencode still isn\'t on your PATH. Open a new shell (so PATH refreshes) and run this again.');
            return 1;
        }
        log('✓ opencode installed.');
    }

    // 2) read existing config (don't clobber invalid JSON)
    const { config, error } = readConfig();
    if (error) {
        err(`✖ ${CONFIG_FILE} exists but couldn't be parsed (${error}).`);
        err('  Fix or remove that file, then run this again — refusing to overwrite it.');
        return 1;
    }

    const isNew = !config.mcp || !config.mcp[SERVER_KEY];

    // 3) merge (idempotent: only the token changes on re-runs) and write
    applyOpencodeConfig(config, { token: opts.token, url: opts.url });
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    } catch (e) {
        err(`✖ Could not write ${CONFIG_FILE}: ${e.message}`);
        return 1;
    }

    log('');
    log(isNew
        ? `✓ Added the "${SERVER_KEY}" MCP to opencode (${CONFIG_FILE}).`
        : `✓ Updated the "${SERVER_KEY}" token in opencode (${CONFIG_FILE}).`);
    log('  Start (or restart) opencode and ask your agent to deploy — the live diagram appears in the web app.');
    return 0;
}

// Run when invoked directly as the bin (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
    runSetupOpencode(process.argv.slice(2)).then((code) => process.exit(code));
}
