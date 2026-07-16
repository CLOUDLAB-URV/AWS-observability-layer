// Feature flags for the web UI. The single source of truth is the BACKEND: we fetch them at
// runtime from GET /api/config (same-origin, proxied to the backend), so the deploy's one
// environment controls both the UI and the API. Nothing is baked into the frontend bundle —
// the image is generic and reacts to whatever the backend reports.
//
// Policy mirrors the backend: a mode is enabled unless explicitly disabled. If the request
// fails we fall back to everything enabled (default-enabled), so the UI never gets stuck.

export async function loadFeatures() {
    try {
        const res = await fetch('/api/config', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`/api/config ${res.status}`);
        const data = await res.json();
        const f = (data && data.features) || {};
        return {
            agent: f.agent !== false
        };
    } catch {
        // Backend unreachable / unexpected response → default to everything enabled.
        return { agent: true };
    }
}
