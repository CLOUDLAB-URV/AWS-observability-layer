'use strict';

// Admin API for the in-app admin panel: full visibility over every account, plus the user-management
// mutations an operator needs day to day — runtime limits, temporary bans, account deletion.
// Gated by the `role: 'admin'` field on the user record. The role itself can ONLY be granted or
// revoked from the operator CLI on the server (scripts/admin-cli.js) — there is deliberately no
// HTTP endpoint that mutates roles, and admin accounts can be neither banned nor deleted here, so
// a compromised admin session cannot lock out or remove other admins.
//
// Every mutation appends to the same JSONL audit log the CLI writes (audit.js), with the acting
// admin's userId as the actor.
//
// In dev the synthetic dev user carries role 'admin' (see auth.js resolveUser), so the panel is
// usable locally without real auth.

import * as authStore from './authStore.js';
import * as visualizerStore from './visualizerStore.js';
import * as tokenStore from './tokenStore.js';
import * as settingsStore from './settingsStore.js';
import * as usageStore from './usageStore.js';
import { requireSession } from './auth.js';
import { auditSafe } from './audit.js';

const MAX_BAN_HOURS = 24 * 365; // one year

export function requireAdmin(req, res, next) {
    // Runs after requireSession, so req.user is always set here. 403 (not 404): the endpoint's
    // existence is not a secret, and an honest status is easier to debug.
    if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required.' });
        return;
    }
    next();
}

// Shared guard for user-targeting mutations: the target must exist, must not be an admin
// (revoke the role via the CLI first), and must not be the acting admin themselves.
async function resolveTarget(req, res) {
    const target = await authStore.getUser(req.params.id);
    if (!target) {
        res.status(404).json({ error: 'not_found' });
        return null;
    }
    if (target.role === 'admin') {
        res.status(409).json({ error: 'Admin accounts cannot be modified from the panel. Revoke the role via the server CLI first.' });
        return null;
    }
    if (target.userId === req.userId) {
        res.status(409).json({ error: 'You cannot target your own account.' });
        return null;
    }
    return target;
}

export function registerAdminRoutes(app) {
    // Every account with its usage: role, verification, ban state, last login, sigil counts,
    // and this month's LLM-token spend. llmMonthTotal aggregates everyone, including the
    // "_design" pseudo-user (legacy bucket for calls with no per-user identity).
    app.get('/api/admin/users', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const [users, stats, llm, llmMonthCap] = await Promise.all([
                authStore.listUsers(),
                authStore.usageStats(),
                usageStore.currentMonthByUser(),
                settingsStore.getSetting('maxLlmTokensPerUserPerMonth')
            ]);
            const withCounts = await Promise.all(users.map(async (u) => {
                const chats = await visualizerStore.listChats(u.userId);
                return {
                    ...u,
                    diagramCount: chats.length,
                    deployedCount: chats.filter((c) => c.deployed).length,
                    llmMonth: llm.byUser[u.userId] ?? { input: 0, output: 0, total: 0, calls: 0 }
                };
            }));
            res.json({ ...stats, users: withCounts, llmMonthTotal: llm.grandTotal, llmMonthCap });
        } catch (error) {
            next(error);
        }
    });

    // Drill-down: one account's sigils (newest first, as listChats already sorts).
    app.get('/api/admin/users/:id/diagrams', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const user = await authStore.getUser(req.params.id);
            if (!user) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            const diagrams = await visualizerStore.listChats(user.userId);
            res.json({ userId: user.userId, username: user.username, diagrams });
        } catch (error) {
            next(error);
        }
    });

    // Runtime limits: effective value + where it comes from (admin override / env / default).
    app.get('/api/admin/settings', requireSession, requireAdmin, async (req, res, next) => {
        try {
            res.json({ settings: await settingsStore.getAllSettings() });
        } catch (error) {
            next(error);
        }
    });

    // Update limits. Body: { maxUsers?, maxSigilsPerUser?, maxTokensPerUser? } — an integer sets
    // an override, null removes it (falls back to the env/default). Overrides persist in the
    // durable volume (persistence/settings.json), so they survive redeploys and migrations.
    app.put('/api/admin/settings', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const patch = req.body ?? {};
            const result = await settingsStore.setSettings(patch);
            if (result.error) {
                res.status(400).json({ error: result.error });
                return;
            }
            auditSafe({ action: 'update_settings', actor: req.userId, detail: patch });
            res.json({ settings: await settingsStore.getAllSettings() });
        } catch (error) {
            next(error);
        }
    });

    // Temporarily ban an account. Body: { hours } (> 0, capped at one year). The ban cuts the
    // user's web session and MCP pushes on their next request and auto-expires.
    app.post('/api/admin/users/:id/ban', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const target = await resolveTarget(req, res);
            if (!target) {
                return;
            }
            const hours = Number(req.body?.hours);
            if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_BAN_HOURS) {
                res.status(400).json({ error: `hours must be a number between 0 and ${MAX_BAN_HOURS}.` });
                return;
            }
            const until = new Date(Date.now() + hours * 3600_000).toISOString();
            const result = await authStore.setBan(target.userId, until);
            if (result.error) {
                res.status(404).json({ error: result.error });
                return;
            }
            auditSafe({ action: 'ban', actor: req.userId, target: target.userId, targetEmail: target.email, detail: { hours, until } });
            res.json({ ok: true, user: result.user });
        } catch (error) {
            next(error);
        }
    });

    // Lift a ban early.
    app.delete('/api/admin/users/:id/ban', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const target = await resolveTarget(req, res);
            if (!target) {
                return;
            }
            const result = await authStore.setBan(target.userId, null);
            if (result.error) {
                res.status(404).json({ error: result.error });
                return;
            }
            auditSafe({ action: 'unban', actor: req.userId, target: target.userId, targetEmail: target.email });
            res.json({ ok: true, user: result.user });
        } catch (error) {
            next(error);
        }
    });

    // Delete an account and everything it owns — same cascade as self-deletion (auth.js):
    // sigils, MCP tokens, sessions, then the user record itself.
    app.delete('/api/admin/users/:id', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const target = await resolveTarget(req, res);
            if (!target) {
                return;
            }
            await visualizerStore.deleteAllForUser(target.userId);
            await tokenStore.revokeAllForUser(target.userId);
            await authStore.deleteAllSessionsForUser(target.userId);
            await authStore.deleteUser(target.userId);
            auditSafe({ action: 'delete_account', actor: req.userId, target: target.userId, targetEmail: target.email });
            res.json({ ok: true });
        } catch (error) {
            next(error);
        }
    });
}
