// Centralized feature flags for the web UI. Single source of truth = the environment
// (client/.env; only VITE_-prefixed vars reach the browser). Vite inlines these at build.
//
// Policy:
//   - DEVELOPMENT (`vite` / `vite dev`, import.meta.env.DEV): everything is available. The
//     flags are IGNORED so you always get the full UI locally.
//   - PRODUCTION build (`vite build`, import.meta.env.PROD): a view is available only if its
//     flag is enabled; anything unset is OFF.

// Parse a boolean-ish env var. Accepts 1/true/yes/on (case-insensitive); else `fallback`.
function envFlag(raw, fallback = false) {
    if (raw == null || raw === '') {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

const isProduction = import.meta.env.PROD;

export const features = {
    // Design & Deploy view. On in dev; in prod only when VITE_DESIGN_ENABLED is set.
    design: isProduction ? envFlag(import.meta.env.VITE_DESIGN_ENABLED, false) : true,
    // Agent (MCP) view. On in dev; in prod only when VITE_AGENT_ENABLED is set.
    agent: isProduction ? envFlag(import.meta.env.VITE_AGENT_ENABLED, false) : true
};
