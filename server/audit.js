'use strict';

// Shared admin-action audit trail: one JSONL line per mutation, appended to
// <auth persistence>/admin-audit.log. Written by BOTH admin surfaces — the
// operator CLI (scripts/admin-cli.js, actor 'cli') and the admin panel routes
// (admin.js, actor = the admin's userId) — so the whole history lives in one
// place on the durable volume. An audit failure must never fail the action
// itself; callers fire-and-forget via auditSafe().

import fs from 'node:fs/promises';
import path from 'node:path';
import { persistDir } from './authStore.js';

const AUDIT_FILE = path.join(persistDir, 'admin-audit.log');

export async function audit(entry) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    await fs.appendFile(AUDIT_FILE, line, 'utf8');
}

// Fire-and-forget variant for request handlers: logs the failure, never throws.
export function auditSafe(entry) {
    audit(entry).catch((error) => console.error('[audit] append failed', error));
}
