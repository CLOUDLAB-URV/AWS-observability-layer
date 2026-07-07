import { useEffect, useMemo, useState } from 'react';
import AdminUserRow from './AdminUserRow.jsx';
import AdminLimits from './AdminLimits.jsx';
import { formatTokens, withinDays } from './format.js';

// Full-page admin view (reached from the profile menu, admins only). Console over every account:
// usage stats, runtime limits editor, searchable user table with per-user drill-down and the
// user-management actions (temporary ban, delete). The menu gating is only UX — the /api/admin
// routes are the real enforcement (403 for non-admins), and this panel surfaces that as an error
// state. Role changes stay CLI-only; admin accounts can't be banned or deleted from here.

async function fetchAdminUsers() {
    const res = await fetch('/api/admin/users', { headers: { Accept: 'application/json' } });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
}

async function fetchAdminUserDiagrams(userId) {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/diagrams`, {
        headers: { Accept: 'application/json' }
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, data };
}

// Mutations share one shape: { ok, error } so rows can surface failures inline.
async function adminMutate(path, init) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, ...init });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, error: data.error };
}

export default function AdminPanel({ user, onBack }) {
    const [state, setState] = useState({ loading: true, error: null, data: null });
    const [query, setQuery] = useState('');
    const [expandedId, setExpandedId] = useState(null);
    const [details, setDetails] = useState({}); // userId → { diagrams } | { error }

    async function load() {
        setState({ loading: true, error: null, data: null });
        try {
            const { ok, status, data } = await fetchAdminUsers();
            if (!ok) {
                setState({
                    loading: false, data: null,
                    error: status === 403 ? "You don't have access to this view." : 'Could not load accounts.'
                });
                return;
            }
            setState({ loading: false, error: null, data });
        } catch {
            setState({ loading: false, error: 'Could not load accounts.', data: null });
        }
    }

    useEffect(() => { load(); }, []);

    async function toggleExpand(userId) {
        const next = expandedId === userId ? null : userId;
        setExpandedId(next);
        if (next && !details[next]) {
            const { ok, data } = await fetchAdminUserDiagrams(next);
            setDetails((d) => ({ ...d, [next]: ok ? { diagrams: data.diagrams || [] } : { error: true } }));
        }
    }

    // Refresh the table in place after a mutation (no loading flash — keep the current data
    // visible while the fresh list arrives).
    async function refresh() {
        const { ok, data } = await fetchAdminUsers();
        if (ok) {
            setState((s) => ({ ...s, data }));
        }
    }

    async function banUser(userId, hours) {
        const result = await adminMutate(`/api/admin/users/${encodeURIComponent(userId)}/ban`, {
            method: 'POST', body: JSON.stringify({ hours })
        });
        if (result.ok) await refresh();
        return result;
    }

    async function unbanUser(userId) {
        const result = await adminMutate(`/api/admin/users/${encodeURIComponent(userId)}/ban`, { method: 'DELETE' });
        if (result.ok) await refresh();
        return result;
    }

    async function deleteUser(userId) {
        const result = await adminMutate(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        if (result.ok) {
            setExpandedId(null);
            await refresh();
        }
        return result;
    }

    const users = state.data?.users || [];

    // Default order: most recently active first (nulls last, then newest account first).
    const sorted = useMemo(() => [...users].sort((a, b) => {
        if (a.lastLogin !== b.lastLogin) return String(b.lastLogin || '').localeCompare(String(a.lastLogin || ''));
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    }), [users]);

    const q = query.trim().toLowerCase();
    const filtered = q
        ? sorted.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
        : sorted;

    const totalSigils = users.reduce((n, u) => n + u.diagramCount, 0);
    const totalLive = users.reduce((n, u) => n + u.deployedCount, 0);
    const active7d = users.filter((u) => withinDays(u.lastLogin, 7)).length;

    return (
        <div className="admin-panel">
            <div className="admin-content">
                <div className="admin-header">
                    <button type="button" className="admin-back-btn" onClick={onBack} aria-label="Back to the app">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M15 6l-6 6 6 6" />
                        </svg>
                        Back
                    </button>
                    <h2 className="admin-title">Admin</h2>
                    {state.data && (
                        <span className="admin-usage">
                            <span className="admin-usage-num">{state.data.totalCount}</span> of{' '}
                            <span className="admin-usage-num">{state.data.maxUsers}</span> accounts
                        </span>
                    )}
                </div>

                {state.loading ? (
                    <div className="dv-pane-empty">Loading accounts…</div>
                ) : state.error ? (
                    <div className="dv-pane-empty admin-error">
                        <span>{state.error}</span>
                        <button type="button" className="link-btn" onClick={load}>Retry</button>
                    </div>
                ) : (
                    <>
                        <div className="admin-stats">
                            <div className="admin-stat-tile">
                                <span className="admin-stat-value">
                                    {state.data.totalCount}<span className="admin-stat-max">/{state.data.maxUsers}</span>
                                </span>
                                <span className="admin-stat-label">Accounts</span>
                            </div>
                            <div className="admin-stat-tile">
                                <span className="admin-stat-value">{state.data.verifiedCount}</span>
                                <span className="admin-stat-label">Verified</span>
                            </div>
                            <div className="admin-stat-tile">
                                <span className="admin-stat-value">
                                    {totalSigils}
                                    {totalLive > 0 && <span className="admin-stat-sub">{totalLive} live</span>}
                                </span>
                                <span className="admin-stat-label">Sigils</span>
                            </div>
                            <div className="admin-stat-tile">
                                <span className="admin-stat-value">{active7d}</span>
                                <span className="admin-stat-label">Active last 7 days</span>
                            </div>
                            <div className="admin-stat-tile" title={`${state.data.llmMonthTotal?.calls ?? 0} calls this month (all users + Design mode)`}>
                                <span className="admin-stat-value">{formatTokens(state.data.llmMonthTotal?.total)}</span>
                                <span className="admin-stat-label">AI tokens (month)</span>
                            </div>
                        </div>

                        <AdminLimits onSaved={refresh} />

                        <div className="admin-toolbar">
                            <div className="admin-search">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="11" cy="11" r="7" />
                                    <path d="M21 21l-4.35-4.35" />
                                </svg>
                                <input
                                    type="search"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Search accounts…"
                                    aria-label="Search accounts by username or email"
                                />
                            </div>
                            {q && (
                                <span className="admin-filter-count">
                                    {filtered.length} of {users.length} match
                                </span>
                            )}
                        </div>

                        {filtered.length === 0 ? (
                            <div className="dv-pane-empty">No accounts match “{query.trim()}”.</div>
                        ) : (
                            <div className="admin-table-wrap">
                                <table className="admin-table">
                                    <thead>
                                        <tr>
                                            <th className="admin-cell-expand" aria-label="Expand" />
                                            <th>User</th>
                                            <th>Role</th>
                                            <th>Status</th>
                                            <th>Verified</th>
                                            <th>Sigils</th>
                                            <th>Created</th>
                                            <th>Last login</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map((u) => (
                                            <AdminUserRow
                                                key={u.userId}
                                                user={u}
                                                isSelf={u.userId === user?.userId}
                                                expanded={expandedId === u.userId}
                                                detail={details[u.userId]}
                                                onToggle={() => toggleExpand(u.userId)}
                                                onBan={banUser}
                                                onUnban={unbanUser}
                                                onDelete={deleteUser}
                                            />
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
