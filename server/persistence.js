'use strict';

// Single source of truth for WHERE the app's file-based stores live, and for the dev/prod
// distinction the rest of the server keys off (see auth.js).
//
// Data lives in persistence/ next to this file, in BOTH dev and prod, so it is durable. In prod the
// Docker image mounts that directory as a volume (survives container recreation); in local dev it is
// just the folder on disk, so the dev user's diagrams and everything persist across restarts — same
// storage behavior as a remote user, locally, for testing.
//
// What's different in DEV is only the identity layer (see auth.js / tokenStore.js): no login, a
// single fixed dev user, and a fixed MCP token from an env var. Storage is identical to prod.
//
// PERSIST_DIR overrides the location explicitly if you ever want a separate directory.
// NODE_ENV=production only flips the DEV flag below; it does not change where data is stored.
//
// authStore.js intentionally does NOT route through here: it keeps its own real persistence/ path
// (with the AUTH_PERSIST_DIR test override), because login is off in dev and so it is never
// exercised there.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// True for local dev (the only place that sets NODE_ENV=production is the Docker image).
export const DEV = process.env.NODE_ENV !== 'production';

// Fixed identity for the local dev profile. In dev there is no login and no token generation:
// every request resolves to this single user, and the MCP authenticates with a fixed token taken
// from DEV_VISUALIZER_TOKEN (or the default below) that maps back to it. Both are constants, so the
// dev user is stable across restarts; its data persists durably in persistence/ like a real user.
export const DEV_USER_ID = 'usr_localdev';
// Must match the MCP/opencode-setup token format /^viz_[A-Za-z0-9]+$/ (no underscores after viz_).
export const DEV_TOKEN = process.env.DEV_VISUALIZER_TOKEN || 'viz_localdev';

let cached = null;

function resolveRoot() {
    if (process.env.PERSIST_DIR) {
        return path.resolve(process.env.PERSIST_DIR);
    }
    // Durable persistence/ next to this file, in both dev and prod.
    return path.join(__dirname, 'persistence');
}

// Resolved once, lazily, and shared by every store so they all agree on the root.
export function persistRoot() {
    if (!cached) {
        cached = resolveRoot();
    }
    return cached;
}
