import { useEffect, useRef, useState } from 'react';
import { formatDate, formatRelative, formatTokens } from './format.js';

// One account row in the admin table + its expandable drill-down (sigils + admin actions).
// The parent owns the expansion state and the lazily-fetched diagram cache, so collapsing and
// re-expanding never refetches. Ban/unban/delete handlers live in the parent too (they refresh
// the table); this component only owns the transient UI state (duration picker, confirm step).

const BAN_CHOICES = [
    { label: '1 hour', hours: 1 },
    { label: '24 hours', hours: 24 },
    { label: '7 days', hours: 168 },
    { label: '30 days', hours: 720 }
];

export default function AdminUserRow({ user, isSelf, expanded, detail, onToggle, onBan, onUnban, onDelete }) {
    const initial = (user.username || user.email || '?').trim().charAt(0).toUpperCase();
    const banned = Boolean(user.bannedUntil);
    // Actions never apply to admins (server rejects; the CLI is the only way to touch admins)
    // nor to the acting admin's own account.
    const actionable = user.role !== 'admin' && !isSelf;

    const [banOpen, setBanOpen] = useState(false);
    const [customHours, setCustomHours] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState(null);
    const confirmTimer = useRef(null);

    useEffect(() => () => clearTimeout(confirmTimer.current), []);

    async function run(action) {
        setBusy(true);
        setActionError(null);
        const { ok, error } = await action();
        setBusy(false);
        if (!ok) {
            setActionError(error || 'Action failed.');
        } else {
            setBanOpen(false);
            setCustomHours('');
            setConfirmDelete(false);
        }
    }

    function askDelete() {
        if (confirmDelete) {
            run(() => onDelete(user.userId));
            return;
        }
        setConfirmDelete(true);
        clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmDelete(false), 4000);
    }

    return (
        <>
            <tr className={`admin-row ${expanded ? 'is-expanded' : ''}`}>
                <td className="admin-cell admin-cell-expand">
                    <button
                        type="button"
                        className="admin-expand-btn"
                        onClick={onToggle}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Hide' : 'Show'} details of ${user.username}`}
                    >
                        <svg className="admin-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                            aria-hidden="true">
                            <path d="M9 6l6 6-6 6" />
                        </svg>
                    </button>
                </td>
                <td className="admin-cell admin-cell-user">
                    <span className="admin-user-wrap">
                        <span className="user-avatar user-avatar-fallback admin-avatar" aria-hidden="true">{initial}</span>
                        <span className="admin-user-id">
                            <span className="admin-user-name">
                                {user.username}
                                {isSelf && <span className="admin-you-pill">you</span>}
                            </span>
                            <span className="admin-user-email">{user.email}</span>
                        </span>
                    </span>
                </td>
                <td className="admin-cell admin-cell-role">
                    {user.role === 'admin'
                        ? <span className="admin-role-pill">admin</span>
                        : <span className="admin-role-plain">user</span>}
                </td>
                <td className="admin-cell admin-cell-status">
                    {banned ? (
                        <span className="admin-banned-pill" title={`Banned until ${formatDate(user.bannedUntil)}`}>banned</span>
                    ) : (
                        <span className="admin-dash" aria-label="Active">—</span>
                    )}
                </td>
                <td className="admin-cell admin-cell-verified">
                    {user.verified ? (
                        <svg className="admin-check" width="15" height="15" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                            aria-label="Verified">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                    ) : (
                        <span className="admin-dash" aria-label="Not verified">—</span>
                    )}
                </td>
                <td className="admin-cell admin-cell-sigils">
                    {user.diagramCount}
                    {user.deployedCount > 0 && (
                        <span className="admin-live-count"> · {user.deployedCount} live</span>
                    )}
                </td>
                <td className="admin-cell admin-cell-date" title={formatDate(user.createdAt)}>
                    {formatRelative(user.createdAt)}
                </td>
                <td className="admin-cell admin-cell-date" title={formatDate(user.lastLogin)}>
                    {formatRelative(user.lastLogin)}
                </td>
            </tr>
            {expanded && (
                <tr className="admin-detail-row">
                    <td colSpan={8} className="admin-user-detail">
                        {!detail ? (
                            <div className="admin-detail-hint">Loading sigils…</div>
                        ) : detail.error ? (
                            <div className="admin-detail-hint">Could not load this account's sigils.</div>
                        ) : detail.diagrams.length === 0 ? (
                            <div className="admin-detail-hint">No sigils.</div>
                        ) : (
                            <ul className="admin-sigil-list">
                                {detail.diagrams.map((d) => (
                                    <li key={d.chatId} className="admin-sigil-row">
                                        <span className="admin-sigil-name">{d.name}</span>
                                        <span className={`badge ${d.deployed ? 'badge-deployed' : 'badge-preview'}`}>
                                            {d.deployed ? 'Live' : 'Design'}
                                        </span>
                                        <span className="admin-sigil-dates">
                                            <span title={formatDate(d.createdAt)}>created {formatRelative(d.createdAt)}</span>
                                            <span title={formatDate(d.updatedAt)}>updated {formatRelative(d.updatedAt)}</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}

                        <div className="admin-llm-usage" title="Gemini tokens this calendar month">
                            AI this month:{' '}
                            <span className="admin-llm-num">{formatTokens(user.llmMonth?.total)}</span> tokens
                            {user.llmMonth?.calls > 0 && (
                                <span className="admin-llm-detail">
                                    {' '}({formatTokens(user.llmMonth.input)} in / {formatTokens(user.llmMonth.output)} out · {user.llmMonth.calls} calls)
                                </span>
                            )}
                        </div>

                        {user.role === 'admin' ? (
                            <div className="admin-detail-hint admin-actions-note">Admin account — no limits apply; manage the role from the server CLI.</div>
                        ) : actionable && (
                            <div className="admin-actions">
                                {banned ? (
                                    <button type="button" className="admin-action-btn" disabled={busy}
                                        onClick={() => run(() => onUnban(user.userId))}>
                                        Unban
                                    </button>
                                ) : banOpen ? (
                                    <span className="admin-ban-picker">
                                        <span className="admin-ban-label">Ban for</span>
                                        {BAN_CHOICES.map(({ label, hours }) => (
                                            <button key={hours} type="button" className="admin-action-btn" disabled={busy}
                                                onClick={() => run(() => onBan(user.userId, hours))}>
                                                {label}
                                            </button>
                                        ))}
                                        <input
                                            type="number" min="1" placeholder="hours" value={customHours}
                                            onChange={(e) => setCustomHours(e.target.value)}
                                            aria-label="Custom ban duration in hours"
                                        />
                                        <button type="button" className="admin-action-btn" disabled={busy || !(Number(customHours) > 0)}
                                            onClick={() => run(() => onBan(user.userId, Number(customHours)))}>
                                            Apply
                                        </button>
                                        <button type="button" className="link-btn" disabled={busy} onClick={() => setBanOpen(false)}>
                                            Cancel
                                        </button>
                                    </span>
                                ) : (
                                    <button type="button" className="admin-action-btn" disabled={busy} onClick={() => setBanOpen(true)}>
                                        Ban…
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className={`admin-action-btn admin-action-danger ${confirmDelete ? 'is-armed' : ''}`}
                                    disabled={busy}
                                    onClick={askDelete}
                                >
                                    {confirmDelete ? 'Confirm delete' : 'Delete account…'}
                                </button>
                                {actionError && <span className="admin-action-error">{actionError}</span>}
                            </div>
                        )}

                        <div className="admin-detail-userid" title="Account id (for the operator CLI)">{user.userId}</div>
                    </td>
                </tr>
            )}
        </>
    );
}
