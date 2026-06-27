// Session helpers for the web UI. Talks to the backend's /api/auth + /api/me (same-origin,
// so the session cookie is sent automatically).

export async function loadSession() {
    try {
        const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`/api/me ${res.status}`);
        // { authEnabled, user } — user is null when auth is on and you're logged out.
        return await res.json();
    } catch {
        // Backend unreachable: assume auth off so the app still renders (it'll reconnect).
        return { authEnabled: false, user: null };
    }
}

export function login() {
    window.location.href = '/api/auth/google/login';
}

export async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
        window.location.reload();
    }
}
