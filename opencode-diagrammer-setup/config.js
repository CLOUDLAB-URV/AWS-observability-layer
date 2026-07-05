'use strict';

// Pure helpers for the opencode setup (no I/O), so they're easy to unit-test. The interactive
// runner in index.js does the file reading/writing and process spawning around these.

// The MCP entry we manage inside opencode's config, under `mcp.sigilum`.
export const SERVER_KEY = 'sigilum';
export const OPENCODE_SCHEMA = 'https://opencode.ai/config.json';

// Build a fresh MCP entry. Mirrors the JSON documented in the README and the web "Connect agent"
// panel: a local server launched via npx, enabled, with the token (and optionally a URL override)
// in its environment.
function freshEntry({ token, url }) {
    return {
        type: 'local',
        command: ['npx', '-y', 'sigilum-mcp@latest'],
        enabled: true,
        environment: {
            SIGILUM_TOKEN: token,
            ...(url ? { SIGILUM_URL: url } : {})
        }
    };
}

// Idempotently ensure `config.mcp["sigilum"]` carries the given token.
//   - no `mcp` / no entry  → create the full entry (and the wrapper objects as needed).
//   - entry already exists → ONLY set environment.SIGILUM_TOKEN, preserving command/type/enabled
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
    existing.environment.SIGILUM_TOKEN = token;
    return config;
}

// Idempotently remove the sigilum MCP entry from opencode's config. No-op (returns false) when
// `mcp` or the entry itself isn't present — running this twice in a row, or against a config that
// never had the entry, does nothing the second time. Cleans up the now-empty `mcp` wrapper, but
// otherwise leaves everything else ($schema, other servers) exactly as it is. Returns the same
// `config` object (mutated) plus whether anything was actually removed.
export function removeOpencodeConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('opencode config must be a JSON object');
    }
    if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp) || !(SERVER_KEY in config.mcp)) {
        return false;
    }
    delete config.mcp[SERVER_KEY];
    if (Object.keys(config.mcp).length === 0) {
        delete config.mcp;
    }
    return true;
}

const TOKEN_RE = /^viz_[A-Za-z0-9]+$/;

// Resolve options from CLI argv (e.g. process.argv.slice(2)) and the environment. Token comes from
// SIGILUM_TOKEN (legacy VISUALIZER_TOKEN also honoured) or --token/-t (an explicit flag overrides
// env). URL from SIGILUM_URL / VISUALIZER_URL (used only when creating the entry). `yes`
// auto-confirms the install prompt. `--uninstall`/`-u` requests removal instead of setup — it
// needs no token, so it short-circuits before the token is resolved/validated.
// Returns { token, url, yes, uninstall }. Throws with a clear message when the token is
// missing/malformed (never thrown when `--uninstall` is passed).
export function parseArgs(argv = [], env = {}) {
    let token = '';
    let yes = false;
    let uninstall = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--token' || arg === '-t') {
            token = argv[i + 1] || '';
            i += 1;
        } else if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length);
        } else if (arg === '--yes' || arg === '-y') {
            yes = true;
        } else if (arg === '--uninstall' || arg === '-u') {
            uninstall = true;
        }
    }
    if (uninstall) {
        return { token: '', url: undefined, yes, uninstall: true };
    }
    if (!token) {
        token = env.SIGILUM_TOKEN || env.VISUALIZER_TOKEN || '';
    }
    token = String(token).trim();
    if (!token) {
        throw new Error('missing token: pass SIGILUM_TOKEN=… (or --token viz_…)');
    }
    if (!TOKEN_RE.test(token)) {
        throw new Error('that token does not look valid (expected a viz_… token from the web UI)');
    }
    const url = String(env.SIGILUM_URL || env.VISUALIZER_URL || '').trim() || undefined;
    return { token, url, yes, uninstall: false };
}
