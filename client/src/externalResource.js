// Resource types that are architecture ACTORS living OUTSIDE AWS — the end user, their
// browser/mobile app, "the internet". They are part of the picture (the diagram draws them)
// but are never deployable, so deployment badges, divergence warnings and cloud status must
// always skip them. The MCP push_sigil docs steer agents to `type:"client"`/`"internet"` for
// these, so a type match is the reliable signal.
const EXTERNAL_TYPES = new Set([
    'client', 'internet', 'user', 'users', 'browser', 'mobile', 'external', 'actor'
]);

// True when the resource is an external (non-AWS, non-deployable) actor.
export function isExternalResource(resource) {
    return EXTERNAL_TYPES.has(String(resource?.type ?? '').toLowerCase().trim());
}
