// Session + auth helpers for the web UI. Talks to the backend's /api/auth + /api/me (same-origin,
// so the session cookie is sent automatically). Internal login: email + username + password with
// an email verification code.

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
}

export async function loadSession() {
    try {
        const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`/api/me ${res.status}`);
        return await res.json(); // { authEnabled, user }
    } catch {
        // Backend unreachable: assume auth off so the app still renders.
        return { authEnabled: false, user: null };
    }
}

export const register = ({ email, username, password }) =>
    postJson('/api/auth/register', { email, username, password });

export const verify = ({ email, code }) => postJson('/api/auth/verify', { email, code });

export const resend = (email) => postJson('/api/auth/resend', { email });

export const login = ({ identifier, password }) => postJson('/api/auth/login', { identifier, password });

export async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
        window.location.reload();
    }
}
