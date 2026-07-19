'use strict';

// Internal login: email + username + password with an email verification code. Hand-rolled with
// node:crypto + the `cookie` dep for signed session cookies, reusing the file-based session store
// in authStore.js. (Google OAuth was removed.)
//
// Auth is ON in production and OFF in local dev (NODE_ENV unset → see persistence.js DEV). In dev
// the login system is bypassed entirely: every request resolves to a single ephemeral "dev" user
// whose data lives only for the session (persistence.js routes the stores to a throwaway temp dir).
// AUTH_DISABLED overrides the default either way (e.g. AUTH_DISABLED=false to test login in dev).

import process from 'node:process';
import crypto from 'node:crypto';
import * as cookie from 'cookie';
import * as authStore from './authStore.js';
import { DEV, DEV_USER_ID } from './persistence.js';
import * as tokenStore from './tokenStore.js';
import * as visualizerStore from './visualizerStore.js';
import { sendVerificationCode, sendPasswordReset, smtpConfigured } from './mailer.js';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds (matches authStore session TTL)

const cfg = {
    appUrl: () => (process.env.APP_URL || '').replace(/\/+$/, ''),
    sessionSecret: () => process.env.SESSION_SECRET || 'dev-insecure-secret'
};

export function authEnabled() {
    // Explicit override wins, in either direction (lets you force login on in dev, or off in prod).
    const flag = String(process.env.AUTH_DISABLED ?? '').trim();
    if (flag !== '') {
        return !/^(1|true|yes|on)$/i.test(flag);
    }
    // Default: ON in production, OFF in local dev (ephemeral no-login profile).
    return !DEV;
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
        // Fixed dev identity (no disk read): the env-var MCP token resolves to this same userId.
        // Dev gets the admin role so the admin panel is testable locally without real auth.
        return { userId: DEV_USER_ID, email: 'dev@localhost', username: 'dev', name: 'Local dev', role: 'admin', dev: true };
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
    // Fire-and-forget: a lastLogin write hiccup must never break the login itself.
    authStore.touchLastLogin(userId).catch(() => {});
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
        if (result.error === 'banned') {
            const until = new Date(result.until).toUTCString();
            res.status(403).json({ error: `This account is suspended until ${until}.` });
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

    // Change the logged-in user's password (requires the current one).
    app.post('/api/auth/password', requireSession, async (req, res) => {
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '');
        if (newPassword.length < 8) {
            res.status(400).json({ error: 'New password must be at least 8 characters.' });
            return;
        }
        const result = await authStore.changePassword(req.userId, currentPassword, newPassword);
        if (result.error === 'bad_current') {
            res.status(400).json({ error: 'Your current password is incorrect.' });
            return;
        }
        if (result.error) {
            res.status(400).json({ error: 'Could not change the password.' });
            return;
        }
        res.json({ ok: true });
    });

    // Rename the logged-in user's account (from the Options modal).
    app.post('/api/auth/username', requireSession, async (req, res) => {
        const username = String(req.body?.username || '').trim();
        if (!USERNAME_RE.test(username)) {
            res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers or underscore.' });
            return;
        }
        const result = await authStore.changeUsername(req.userId, username);
        if (result.error === 'username_taken') {
            res.status(409).json({ error: 'That username is taken.' });
            return;
        }
        if (result.error) {
            res.status(400).json({ error: 'Could not change the username.' });
            return;
        }
        res.json({ ok: true, user: result.user });
    });

    // Set or remove the profile picture. The client downsizes to a small square before sending,
    // so the payload is a tiny data URL; the size cap here is just a hard backstop.
    const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
    const AVATAR_MAX_CHARS = 200_000; // ~150 KB decoded — far above the ~15 KB a 128×128 JPEG needs
    app.post('/api/auth/avatar', requireSession, async (req, res) => {
        const avatar = req.body?.avatar ?? null;
        if (avatar !== null && (typeof avatar !== 'string' || !AVATAR_RE.test(avatar) || avatar.length > AVATAR_MAX_CHARS)) {
            res.status(400).json({ error: 'Avatar must be a small JPEG/PNG/WebP image.' });
            return;
        }
        const result = await authStore.setAvatar(req.userId, avatar);
        if (result.error) {
            res.status(400).json({ error: 'Could not update the profile picture.' });
            return;
        }
        res.json({ ok: true, user: result.user });
    });

    // Invalidate every session of the logged-in user (all devices), including this one.
    app.post('/api/auth/logout-all', requireSession, async (req, res) => {
        await authStore.deleteAllSessionsForUser(req.userId);
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    // Permanently delete the logged-in user's account and all their data. Confirmation is a
    // re-typed username + current password.
    app.delete('/api/auth/account', requireSession, async (req, res) => {
        const username = String(req.body?.username || '').trim();
        const password = String(req.body?.password || '');
        // Re-check both the username (must match the session user) and the password.
        if (username.toLowerCase() !== String(req.user.username || '').toLowerCase()) {
            res.status(400).json({ error: 'The username does not match your account.' });
            return;
        }
        const check = await authStore.verifyLogin(username, password);
        if (check.error || check.user?.userId !== req.userId) {
            res.status(400).json({ error: 'Your password is incorrect.' });
            return;
        }
        // Wipe everything the user owns, then the account itself.
        await visualizerStore.deleteAllForUser(req.userId);
        await tokenStore.revokeAllForUser(req.userId);
        await authStore.deleteAllSessionsForUser(req.userId);
        await authStore.deleteUser(req.userId);
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    // Request a password-reset link. Always responds OK (never reveals whether the email exists).
    app.post('/api/auth/forgot', async (req, res) => {
        const email = String(req.body?.email || '').trim();
        if (!EMAIL_RE.test(email)) {
            res.status(400).json({ error: 'Enter a valid email address.' });
            return;
        }
        const result = await authStore.createResetToken(email);
        let devResetUrl;
        if (result.token) {
            const resetUrl = `${cfg.appUrl() || ''}/reset?token=${result.token}`;
            try {
                await sendPasswordReset(email, resetUrl, result.username);
            } catch (error) {
                console.error('[mailer] reset send failed', error);
                res.status(502).json({ error: 'Could not send the email. Try again shortly.' });
                return;
            }
            if (!smtpConfigured()) {
                devResetUrl = resetUrl;
            }
        }
        res.json({ ok: true, ...(devResetUrl ? { devResetUrl } : {}) });
    });

    // Complete a password reset with the token from the email link.
    app.post('/api/auth/reset', async (req, res) => {
        const token = String(req.body?.token || '').trim();
        const password = String(req.body?.password || '');
        if (!token) {
            res.status(400).json({ error: 'Missing reset token.' });
            return;
        }
        if (password.length < 8) {
            res.status(400).json({ error: 'Password must be at least 8 characters.' });
            return;
        }
        const result = await authStore.consumeResetToken(token, password);
        if (result.error === 'expired') {
            res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
            return;
        }
        if (result.error) {
            res.status(400).json({ error: 'This reset link is invalid. Request a new one.' });
            return;
        }
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
