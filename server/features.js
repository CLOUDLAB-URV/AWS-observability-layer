'use strict';

// Centralized feature flags for the backend, and the single source of truth for the whole
// app: the frontend reads these at runtime via GET /api/config, so one environment controls
// both sides. Config comes from the environment (injected by the deploy, or .env.local in
// local dev) — nothing is baked into the image.
//
// Policy: a mode is ENABLED unless explicitly disabled.
//   - unset / empty           → enabled  (a bare container = full "test" environment)
//   - false / 0 / no / off     → disabled
//   - 1 / true / yes / on      → enabled
//
// Read LAZILY (getters): in ESM this module is evaluated before index.js runs
// process.loadEnvFile(), so reading at import time would miss the .env.local values.

import process from 'node:process';

// Parse a boolean-ish env var. Unset/empty → `fallback`; otherwise enabled only for an
// affirmative value (1/true/yes/on), so false/0/no/off disable it.
function envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const features = {
    // Design & Deploy: the LangGraph orchestration flow (chat / deploy / teardown /
    // projects). Disable with DESIGN_ENABLED=false.
    get design() {
        return envFlag('DESIGN_ENABLED', true);
    },
    // Agent (MCP): the deployed-state visualizer (/api/chats, /api/tokens, push
    // deployments, /ws-visualizer). Disable with AGENT_ENABLED=false.
    get agent() {
        return envFlag('AGENT_ENABLED', true);
    }
};
