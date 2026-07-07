import { formatDate, formatRelative } from './format.js';

// One account row in the admin table + its expandable sigil drill-down. The parent owns the
// expansion state and the lazily-fetched diagram cache, so collapsing/re-expanding never refetches.
export default function AdminUserRow({ user, isSelf, expanded, detail, onToggle }) {
    const initial = (user.username || user.email || '?').trim().charAt(0).toUpperCase();
    return (
        <>
            <tr className={`admin-row ${expanded ? 'is-expanded' : ''}`}>
                <td className="admin-cell admin-cell-expand">
                    <button
                        type="button"
                        className="admin-expand-btn"
                        onClick={onToggle}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Hide' : 'Show'} sigils of ${user.username}`}
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
                    <td colSpan={7} className="admin-user-detail">
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
                        <div className="admin-detail-userid" title="Account id (for the operator CLI)">{user.userId}</div>
                    </td>
                </tr>
            )}
        </>
    );
}
