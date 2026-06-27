'use strict';

// Google OAuth 2.0 login (Authorization Code + PKCE + state) and signed session cookies.
// Hand-rolled with the built-in fetch + node:crypto to keep deps minimal (only `cookie` for
// safe header parse/serialize), matching the rest of the codebase's small file-based stores.
//
// Auth is ACTIVE only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are configured. Locally
// (no creds) it's OFF: requests resolve to a single "dev" user (the machine owner), so local
// dev keeps working with no login. In the deploy (creds set) login is required.

import process from 'node:process';
import crypto from 'node:crypto';
import * as cookie from 'cookie';
import * as authStore from './authStore.js';
import * as tokenStore from './tokenStore.js';

const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

// --- config (read lazily; env is loaded by index.js before requests) ----------------------
const cfg = {
    clientId: () => process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || '',
    appUrl: () => (process.env.APP_URL || '').replace(/\/+$/, ''),
    sessionSecret: () => process.env.SESSION_SECRET || 'dev-insecure-secret'
};

export function authEnabled() {
    return Boolean(cfg.clientId() && cfg.clientSecret());
}

function redirectUri() {
    // Falls back to a relative path only matters when auth is on, where APP_URL must be set.
    return `${cfg.appUrl()}/api/auth/google/callback`;
}

function isSecure() {
    return cfg.appUrl().startsWith('https://');
}

// --- cookie signing (HMAC) ----------------------------------------------------------------
function sign(value) {
    const mac = crypto.createHmac('sha256', cfg.sessionSecret()).update(value).digest('base64url');
    return `${value}.${mac}`;
}

function unsign(signed) {
    const i = String(signed ?? '').lastIndexOf('.');
    if (i < 0) {
        return null;
    }
    const value = signed.slice(0, i);
    const expected = crypto.createHmac('sha256', cfg.sessionSecret()).update(value).digest('base64url');
    const got = signed.slice(i + 1);
    if (got.length !== expected.length) {
        return null;
    }
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)) ? value : null;
}

function readCookies(req) {
    return cookie.parse(req.headers?.cookie || '');
}

function setCookie(res, name, value, { maxAge } = {}) {
    res.append('Set-Cookie', cookie.serialize(name, value, {
        httpOnly: true,
        secure: isSecure(),
        sameSite: 'lax',
        path: '/',
        ...(maxAge != null ? { maxAge } : {})
    }));
}

function clearCookie(res, name) {
    res.append('Set-Cookie', cookie.serialize(name, '', {
        httpOnly: true, secure: isSecure(), sameSite: 'lax', path: '/', maxAge: 0
    }));
}

// --- session resolution (HTTP + WS share this) --------------------------------------------
// Returns the public user for the request, or null. When auth is OFF, returns the owner as a
// synthetic "dev" user so the whole app works locally without login.
export async function resolveUser(req) {
    if (!authEnabled()) {
        const userId = await tokenStore.getOwnerUserId();
        return { userId, email: 'dev@localhost', name: 'Local dev', picture: '', dev: true };
    }
    const signed = readCookies(req)[SESSION_COOKIE];
    const sid = signed ? unsign(signed) : null;
    return sid ? authStore.getSessionUser(sid) : null;
}

// Express middleware: 401 when auth is on and there is no valid session. Sets req.userId.
export function requireSession(req, res, next) {
    resolveUser(req).then((user) => {
        if (!user) {
            res.status(401).json({ error: 'Not authenticated.' });
            return;
        }
        req.user = user;
        req.userId = user.userId;
        next();
    }).catch(next);
}

// --- OAuth endpoints ----------------------------------------------------------------------
export function registerRoutes(app) {
    // Begin login: stash state + PKCE verifier (signed cookie), redirect to Google.
    app.get('/api/auth/google/login', (req, res) => {
        if (!authEnabled()) {
            res.redirect('/');
            return;
        }
        const state = crypto.randomBytes(16).toString('hex');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        // Pack state + verifier into one short-lived signed cookie.
        setCookie(res, STATE_COOKIE, sign(`${state}:${verifier}`), { maxAge: 600 });
        const params = new URLSearchParams({
            client_id: cfg.clientId(),
            redirect_uri: redirectUri(),
            response_type: 'code',
            scope: 'openid email profile',
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            access_type: 'online',
            prompt: 'select_account'
        });
        res.redirect(`${GOOGLE_AUTH}?${params.toString()}`);
    });

    // Callback: validate state, exchange code, fetch profile, create user + session.
    app.get('/api/auth/google/callback', async (req, res) => {
        if (!authEnabled()) {
            res.redirect('/');
            return;
        }
        try {
            const packed = unsign(readCookies(req)[STATE_COOKIE]);
            clearCookie(res, STATE_COOKIE);
            if (!packed) {
                res.status(400).send('Invalid auth state. Please try logging in again.');
                return;
            }
            const [expectedState, verifier] = packed.split(':');
            if (!req.query.state || req.query.state !== expectedState || !req.query.code) {
                res.status(400).send('Invalid auth state. Please try logging in again.');
                return;
            }

            const tokenRes = await fetch(GOOGLE_TOKEN, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: cfg.clientId(),
                    client_secret: cfg.clientSecret(),
                    code: String(req.query.code),
                    code_verifier: verifier,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri()
                })
            });
            if (!tokenRes.ok) {
                throw new Error(`token exchange failed (${tokenRes.status})`);
            }
            const { access_token: accessToken } = await tokenRes.json();

            const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
            if (!infoRes.ok) {
                throw new Error(`userinfo failed (${infoRes.status})`);
            }
            const info = await infoRes.json();

            const user = await authStore.findOrCreateUser({
                sub: info.sub,
                email: info.email,
                name: info.name,
                picture: info.picture
            });
            if (!user) {
                res.status(403).send('This deployment has reached its maximum number of users.');
                return;
            }

            const sid = await authStore.createSession(user.userId);
            setCookie(res, SESSION_COOKIE, sign(sid), { maxAge: 30 * 24 * 60 * 60 });
            res.redirect('/');
        } catch (error) {
            console.error('[auth callback failed]', error);
            res.status(500).send('Login failed. Please try again.');
        }
    });

    // Logout: drop the session record + cookie.
    app.post('/api/auth/logout', async (req, res) => {
        const sid = unsign(readCookies(req)[SESSION_COOKIE]);
        if (sid) {
            await authStore.deleteSession(sid);
        }
        clearCookie(res, SESSION_COOKIE);
        res.json({ ok: true });
    });

    // Who am I? The frontend uses this to decide whether to show the login screen.
    app.get('/api/me', async (req, res) => {
        const user = await resolveUser(req);
        res.json({ authEnabled: authEnabled(), user });
    });
}

// Exposed for unit tests.
export const _internal = { sign, unsign };
