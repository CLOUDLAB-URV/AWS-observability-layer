'use strict';

// Pure helpers for the opencode setup (no I/O), so they're easy to unit-test. The interactive
// runner in index.js does the file reading/writing and process spawning around these.

// The MCP entry we manage inside opencode's config, under `mcp.diagram-state-visualizer`.
export const SERVER_KEY = 'diagram-state-visualizer';
export const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';

// Build a fresh MCP entry. Mirrors the JSON documented in the README and the web "Connect agent"
// panel: a local server launched via npx, enabled, with the token (and optionally a URL override)
// in its environment.
function freshEntry({ token, url }) {
    return {
        type: 'local',
        command: ['npx', '-y', 'diagram-state-visualizer-mcp@latest'],
        enabled: true,
        environment: {
            VISUALIZER_TOKEN: token,
            ...(url ? { VISUALIZER_URL: url } : {})
        }
    };
}

// Idempotently ensure `config.mcp["diagram-state-visualizer"]` carries the given token.
//   - no `mcp` / no entry  → create the full entry (and the wrapper objects as needed).
//   - entry already exists → ONLY set environment.VISUALIZER_TOKEN, preserving command/type/enabled
//     and any extra fields the user added, exactly where they are.
// `url` is only applied when the entry is created (never overwritten on re-runs), matching the
// "only the token changes when re-run" guarantee. Returns the same `config` object (mutated).
export function applyOpencodeConfig(config, { token, url } = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('opencode config must be a JSON object');
    }
    if (!token) {
        throw new Error('a token is required');
    }

    // Seed $schema first (so it lands at the top of a freshly created file) when the config is empty.
    const wasEmpty = Object.keys(config).length === 0;
    if (wasEmpty && !config.$schema) {
        config.$schema = OPENCODE_SCHEMA;
    }

    if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
        config.mcp = {};
    }

    const existing = config.mcp[SERVER_KEY];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        config.mcp[SERVER_KEY] = freshEntry({ token, url });
        return config;
    }

    // Entry present → touch ONLY the token, leaving everything else as-is.
    if (!existing.environment || typeof existing.environment !== 'object' || Array.isArray(existing.environment)) {
        existing.environment = {};
    }
    existing.environment.VISUALIZER_TOKEN = token;
    return config;
}

const TOKEN_RE = /^viz_[A-Za-z0-9]+$/;

// Resolve options from CLI argv (e.g. process.argv.slice(2)) and the environment. Token comes from
// VISUALIZER_TOKEN or --token/-t (env wins is NOT assumed — an explicit flag overrides env). URL
// from VISUALIZER_URL (used only when creating the entry). `yes` auto-confirms the install prompt.
// Returns { token, url, yes }. Throws with a clear message when the token is missing/malformed.
export function parseArgs(argv = [], env = {}) {
    let token = '';
    let yes = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--token' || arg === '-t') {
            token = argv[i + 1] || '';
            i += 1;
        } else if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length);
        } else if (arg === '--yes' || arg === '-y') {
            yes = true;
        }
    }
    if (!token) {
        token = env.VISUALIZER_TOKEN || '';
    }
    token = String(token).trim();
    if (!token) {
        throw new Error('missing token: pass VISUALIZER_TOKEN=… (or --token viz_…)');
    }
    if (!TOKEN_RE.test(token)) {
        throw new Error('that token does not look valid (expected a viz_… token from the web UI)');
    }
    const url = String(env.VISUALIZER_URL || '').trim() || undefined;
    return { token, url, yes };
}
