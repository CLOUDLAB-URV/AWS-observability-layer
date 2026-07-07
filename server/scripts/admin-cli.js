#!/usr/bin/env node
'use strict';

// Operator CLI for admin-role management. This is the ONLY way to grant or revoke the admin role
// (there is deliberately no HTTP endpoint for it — see admin.js). It imports authStore.js
// directly, so it reads/writes the exact same users.json as the running server (same
// AUTH_PERSIST_DIR resolution). On the deployed VPS the persistence volume is only mounted in
// the backend container, so run it there:
//
//   docker compose exec backend npm run admin -- list
//   docker compose exec backend npm run admin -- grant alice@example.com
//   docker compose exec backend npm run admin -- revoke alice --yes
//
// Role changes take effect on the target user's next request (sessions re-read the user record).
// Every grant/revoke appends a JSONL line to <persistence>/admin-audit.log.

import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import * as readline from 'node:readline/promises';
import * as authStore from '../authStore.js';

const AUDIT_FILE = path.join(authStore.persistDir, 'admin-audit.log');

const HELP = `Sigilum admin CLI — manage the admin role from the server.

Usage: npm run admin -- <command> [args] [flags]

Commands:
  list                       Table of all accounts
  grant  <email|username>    Promote an account to admin
  revoke <email|username>    Demote an admin to regular user
  stats                      Account/usage summary
  help                       Show this text

Flags:
  --yes, -y                  Skip the confirmation prompt (grant/revoke)
`;

function fmtDate(iso) {
    if (!iso) {
        return 'never';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return 'never';
    }
    return d.toISOString().slice(0, 16).replace('T', ' ');
}

// Plain-text table: pad each column to its widest value. No deps, no box-drawing.
function printTable(headers, rows) {
    const all = [headers, ...rows];
    const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
    for (const row of all) {
        console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd());
    }
}

async function audit(entry) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry, actor: 'cli', host: os.hostname() })}\n`;
    await fs.appendFile(AUDIT_FILE, line, 'utf8');
}

async function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === 'y' || answer === 'yes';
}

async function findUser(identifier) {
    const key = String(identifier ?? '').trim().toLowerCase();
    const users = await authStore.listUsers();
    return users.find((u) => u.email.toLowerCase() === key || u.username.toLowerCase() === key) || null;
}

function printAccount(u) {
    console.log(`  ${u.userId}  ${u.username}  ${u.email}  role: ${u.role}  verified: ${u.verified ? 'yes' : 'no'}`);
}

async function cmdList() {
    const users = await authStore.listUsers();
    if (users.length === 0) {
        console.log('No accounts.');
        return 0;
    }
    printTable(
        ['ID', 'USERNAME', 'EMAIL', 'ROLE', 'VERIFIED', 'LAST LOGIN', 'CREATED'],
        users.map((u) => [
            u.userId, u.username, u.email, u.role,
            u.verified ? 'yes' : 'no', fmtDate(u.lastLogin), fmtDate(u.createdAt)
        ])
    );
    return 0;
}

async function cmdStats() {
    const s = await authStore.usageStats();
    console.log(`Accounts: ${s.totalCount} of ${s.maxUsers}`);
    console.log(`Verified: ${s.verifiedCount}`);
    console.log(`Admins:   ${s.adminCount}`);
    return 0;
}

async function cmdSetRole(identifier, role, yes) {
    if (!identifier) {
        console.error('Missing account identifier (email or username).');
        console.error(HELP);
        return 1;
    }
    const user = await findUser(identifier);
    if (!user) {
        console.error(`No account matches "${identifier}".`);
        return 1;
    }
    console.log('Matched account:');
    printAccount(user);
    // Idempotent no-ops exit 0 so the command is safe to script.
    if (user.role === role) {
        console.log(role === 'admin' ? 'Already an admin — nothing to do.' : 'Not an admin — nothing to do.');
        return 0;
    }
    const verb = role === 'admin' ? 'Grant admin to' : 'Revoke admin from';
    if (!yes && !(await confirm(`${verb} this account?`))) {
        console.error('Aborted.');
        return 1;
    }
    const result = await authStore.setRole(identifier, role);
    if (result.error) {
        console.error(`Failed: ${result.error}`);
        return 1;
    }
    await audit({
        action: role === 'admin' ? 'grant_admin' : 'revoke_admin',
        targetUserId: result.user.userId,
        targetEmail: result.user.email,
        previousRole: result.previousRole
    });
    console.log(`Done — ${result.user.username} (${result.user.email}) is now role: ${result.user.role}.`);
    return 0;
}

async function main() {
    const { values, positionals } = parseArgs({
        options: { yes: { type: 'boolean', short: 'y', default: false }, help: { type: 'boolean', default: false } },
        allowPositionals: true
    });
    const [command, identifier] = positionals;

    if (values.help || !command || command === 'help') {
        console.log(HELP);
        return command || values.help ? 0 : 1;
    }
    switch (command) {
        case 'list':
            return cmdList();
        case 'stats':
            return cmdStats();
        case 'grant':
            return cmdSetRole(identifier, 'admin', values.yes);
        case 'revoke':
            return cmdSetRole(identifier, 'user', values.yes);
        default:
            console.error(`Unknown command "${command}".`);
            console.error(HELP);
            return 1;
    }
}

main().then((code) => {
    process.exitCode = code;
}, (error) => {
    console.error(`Unexpected error: ${error?.message || error}`);
    process.exitCode = 2;
});
