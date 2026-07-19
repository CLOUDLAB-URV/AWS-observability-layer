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

export const changePassword = ({ currentPassword, newPassword }) =>
    postJson('/api/auth/password', { currentPassword, newPassword });

export const changeUsername = (username) => postJson('/api/auth/username', { username });

// `avatar` is a small data-URL string, or null to remove the picture.
export const setAvatar = (avatar) => postJson('/api/auth/avatar', { avatar });

export const logoutAll = () => postJson('/api/auth/logout-all', {});

export async function loadMyUsage() {
    const res = await fetch('/api/me/usage');
    if (!res.ok) throw new Error(`/api/me/usage ${res.status}`);
    return res.json(); // { llm:{input,output,total,calls}, llmLimit, sigils, sigilLimit }
}

export const forgotPassword = (email) => postJson('/api/auth/forgot', { email });

export const resetPassword = ({ token, password }) => postJson('/api/auth/reset', { token, password });

export async function deleteAccount({ username, password }) {
    const res = await fetch('/api/auth/account', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
}

export async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
        window.location.reload();
    }
}
