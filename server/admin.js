'use strict';

// Admin API: read-only visibility over every account and its sigils, for the in-app admin panel.
// Gated by the `role: 'admin'` field on the user record. The role itself can ONLY be granted or
// revoked from the operator CLI on the server (scripts/admin-cli.js) — there is deliberately no
// HTTP endpoint that mutates roles, so there is no self-promotion/demotion surface to secure.
//
// In dev the synthetic dev user carries role 'admin' (see auth.js resolveUser), so the panel is
// usable locally without real auth.

import * as authStore from './authStore.js';
import * as visualizerStore from './visualizerStore.js';
import { requireSession } from './auth.js';

export function requireAdmin(req, res, next) {
    // Runs after requireSession, so req.user is always set here. 403 (not 404): the endpoint's
    // existence is not a secret, and an honest status is easier to debug.
    if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required.' });
        return;
    }
    next();
}

export function registerAdminRoutes(app) {
    // Every account with its usage: role, verification, last login, and sigil counts.
    app.get('/api/admin/users', requireSession, requireAdmin, async (req, res, next) => {
        try {
            const [users, stats] = await Promise.all([authStore.listUsers(), authStore.usageStats()]);
            const withCounts = await Promise.all(users.map(async (u) => {
                const chats = await visualizerStore.listChats(u.userId);
                return {
                    ...u,
                    diagramCount: chats.length,
                    deployedCount: chats.filter((c) => c.deployed).length
                };
            }));
            res.json({ ...stats, users: withCounts });
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
}
