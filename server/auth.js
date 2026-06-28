'use strict';

// Internal login: email + username + password with an email verification code. Hand-rolled with
// node:crypto + the `cookie` dep for signed session cookies, reusing the file-based session store
// in authStore.js. (Google OAuth was removed.)
//
// Auth is ON by default. Set AUTH_DISABLED=true to run open locally: requests resolve to a single
// "dev" user (the machine owner) so the app works with no login.

import process from 'node:process';
import crypto from 'node:crypto';
import * as cookie from 'cookie';
import * as authStore from './authStore.js';
import * as tokenStore from './tokenStore.js';
import { sendVerificationCode, smtpConfigured } from './mailer.js';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds (matches authStore session TTL)

const cfg = {
    appUrl: () => (process.env.APP_URL || '').replace(/\/+$/, ''),
    sessionSecret: () => process.env.SESSION_SECRET || 'dev-insecure-secret'
};

export function authEnabled() {
    return !/^(1|true|yes|on)$/i.test(String(process.env.AUTH_DISABLED || '').trim());
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

function setSessionCookie(res, sid) {
    res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, sign(sid), {
        httpOnly: true, secure: isSecure(), sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE
    }));
}

function clearSessionCookie(res) {
    res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', {
        httpOnly: true, secure: isSecure(), sameSite: 'lax', path: '/', maxAge: 0
    }));
}

// --- session resolution (HTTP + WS share this) --------------------------------------------
export async function resolveUser(req) {
    if (!authEnabled()) {
        const userId = await tokenStore.getOwnerUserId();
        return { userId, email: 'dev@localhost', username: 'dev', name: 'Local dev', dev: true };
    }
    const signed = readCookies(req)[SESSION_COOKIE];
    const sid = signed ? unsign(signed) : null;
    return sid ? authStore.getSessionUser(sid) : null;
}

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

// --- validation ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;

function validateRegistration({ email, username, password }) {
    if (!EMAIL_RE.test(String(email || ''))) {
        return 'Enter a valid email address.';
    }
    if (!USERNAME_RE.test(String(username || ''))) {
        return 'Username must be 3–30 characters: letters, numbers or underscore.';
    }
    if (String(password || '').length < 8) {
        return 'Password must be at least 8 characters.';
    }
    return null;
}

async function startSession(res, userId) {
    const sid = await authStore.createSession(userId);
    setSessionCookie(res, sid);
}

// --- routes -------------------------------------------------------------------------------
export function registerRoutes(app) {
    // Create a pending account and email a verification code.
    app.post('/api/auth/register', async (req, res) => {
        const email = String(req.body?.email || '').trim();
        const username = String(req.body?.username || '').trim();
        const password = String(req.body?.password || '');

        const invalid = validateRegistration({ email, username, password });
        if (invalid) {
            res.status(400).json({ error: invalid });
            return;
        }

        const result = await authStore.createPendingUser({ email, username, password });
        if (result.error === 'email_taken') {
            res.status(409).json({ error: 'That email is already registered.' });
            return;
        }
        if (result.error === 'username_taken') {
            res.status(409).json({ error: 'That username is taken.' });
            return;
        }
        if (result.error === 'limit') {
            res.status(403).json({ error: 'This deployment has reached its maximum number of users.' });
            return;
        }

        try {
            await sendVerificationCode(email, result.code, username);
        } catch (error) {
            console.error('[mailer] send failed', error);
            res.status(502).json({ error: 'Could not send the verification email. Try again shortly.' });
            return;
        }
        // In dev (no SMTP) return the code so local testing works without an inbox.
        res.json({ ok: true, email, ...(smtpConfigured() ? {} : { devCode: result.code }) });
    });

    // Verify the code → mark verified and start a session.
    app.post('/api/auth/verify', async (req, res) => {
        const email = String(req.body?.email || '').trim();
        const code = String(req.body?.code || '').trim();
        if (!email || !/^\d{6}$/.test(code)) {
            res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
            return;
        }
        const result = await authStore.verifyEmailCode(email, code);
        if (result.error) {
            const map = {
                not_found: [404, 'No pending sign-up for that email.'],
                no_code: [400, 'No active code — request a new one.'],
                expired: [400, 'That code has expired — request a new one.'],
                too_many: [429, 'Too many attempts — request a new code.'],
                bad_code: [400, 'Incorrect code. Check it and try again.']
            };
            const [status, message] = map[result.error] || [400, 'Could not verify the code.'];
            res.status(status).json({ error: message });
            return;
        }
        await startSession(res, result.user.userId);
        res.json({ ok: true, user: result.user });
    });

    // Resend a verification code (rate-limited by a cooldown).
    app.post('/api/auth/resend', async (req, res) => {
        const email = String(req.body?.email || '').trim();
        if (!EMAIL_RE.test(email)) {
            res.status(400).json({ error: 'Enter a valid email address.' });
            return;
        }
        const result = await authStore.resendCode(email);
        if (result.error === 'cooldown') {
            res.status(429).json({ error: 'Please wait a few seconds before requesting another code.' });
            return;
        }
        // For not_found / already_verified, respond OK without leaking which it was.
        if (result.code) {
            try {
                await sendVerificationCode(email, result.code, '');
            } catch (error) {
                console.error('[mailer] resend failed', error);
                res.status(502).json({ error: 'Could not send the email. Try again shortly.' });
                return;
            }
        }
        res.json({ ok: true, email, ...(result.code && !smtpConfigured() ? { devCode: result.code } : {}) });
    });

    // Log in with email-or-username + password.
    app.post('/api/auth/login', async (req, res) => {
        const identifier = String(req.body?.identifier || '').trim();
        const password = String(req.body?.password || '');
        if (!identifier || !password) {
            res.status(400).json({ error: 'Enter your email/username and password.' });
            return;
        }
        const result = await authStore.verifyLogin(identifier, password);
        if (result.error === 'unverified') {
            // Help the user finish: send a fresh code and route them to the verify step.
            const r = await authStore.resendCode(result.email);
            res.status(403).json({
                needsVerify: true,
                email: result.email,
                ...(r.code && !smtpConfigured() ? { devCode: r.code } : {})
            });
            if (r.code) {
                sendVerificationCode(result.email, r.code, '').catch((e) => console.error('[mailer]', e));
            }
            return;
        }
        if (result.error) {
            res.status(401).json({ error: 'Wrong email/username or password.' });
            return;
        }
        await startSession(res, result.user.userId);
        res.json({ ok: true, user: result.user });
    });

    app.post('/api/auth/logout', async (req, res) => {
        const sid = unsign(readCookies(req)[SESSION_COOKIE]);
        if (sid) {
            await authStore.deleteSession(sid);
        }
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    // Who am I? The frontend uses this to decide whether to show the auth screen.
    app.get('/api/me', async (req, res) => {
        const user = await resolveUser(req);
        res.json({ authEnabled: authEnabled(), user });
    });
}

// Exposed for unit tests.
export const _internal = { sign, unsign };
