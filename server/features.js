'use strict';

// Centralized feature flags for the backend. Single source of truth = the environment
// (.env, with secrets in .env.local). Standard "config in the environment" (12-factor).
//
// Policy:
//   - DEVELOPMENT (default; NODE_ENV != "production"): everything is available. The flags
//     are IGNORED so you always get the full app locally.
//   - PRODUCTION (NODE_ENV=production): a feature is available only if its flag is enabled
//     in the environment; anything unset is OFF.
//
// Read LAZILY (getters): in ESM this module is evaluated before index.js runs
// process.loadEnvFile(), so reading at import time would miss the .env values.

import process from 'node:process';

// Parse a boolean-ish env var. Accepts 1/true/yes/on (case-insensitive); else `fallback`.
function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null || raw === '') {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(raw.trim());
}

function isProduction() {
    return (process.env.NODE_ENV || 'development') === 'production';
}

export const features = {
    // Design & Deploy: the LangGraph orchestration flow (chat / deploy / teardown /
    // projects). On in dev; in prod only when DESIGN_ENABLED is set.
    get design() {
        return isProduction() ? envFlag('DESIGN_ENABLED', false) : true;
    },
    // Agent (MCP): the deployed-state visualizer (/api/chats, /api/tokens, push
    // deployments, /ws-visualizer). On in dev; in prod only when AGENT_ENABLED is set.
    get agent() {
        return isProduction() ? envFlag('AGENT_ENABLED', false) : true;
    }
};
