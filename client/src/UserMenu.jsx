import { useEffect, useRef, useState } from 'react';
import { changePassword, deleteAccount, logout } from './auth.js';

// Profile menu in the top bar: the avatar + name is a trigger that opens a dropdown with the
// account actions (Change password, Delete account, Log out). The old always-visible Logout
// button lives here now. Two of the actions open their own modal (reusing the .modal-* shell).
// Admins additionally get an "Admin view" entry (server-enforced — the menu gating is only UX).
export default function UserMenu({ user, onOpenAdmin }) {
    const [open, setOpen] = useState(false);
    const [modal, setModal] = useState(null); // null | 'password' | 'delete'
    const wrapRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onClick);
        window.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onClick);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const label = user.username || user.name || user.email;
    const initial = (user.username || user.name || user.email || '?').trim().charAt(0).toUpperCase();

    return (
        <div className="user-menu" ref={wrapRef}>
            <button
                type="button"
                className={`user-menu-trigger ${open ? 'is-open' : ''}`}
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                title={user.email || label}
            >
                <span className="user-avatar user-avatar-fallback" aria-hidden="true">{initial}</span>
                <span className="user-name">{label}</span>
                <svg className="user-menu-caret" width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                </svg>
            </button>

            {open && (
                <div className="user-menu-pop" role="menu">
                    <div className="user-menu-head">
                        <div className="user-menu-head-name">{label}</div>
                        {user.email && <div className="user-menu-head-email">{user.email}</div>}
                    </div>
                    {user.role === 'admin' && onOpenAdmin && (
                        <>
                            <button type="button" className="user-menu-item" role="menuitem"
                                onClick={() => { setOpen(false); onOpenAdmin(); }}>
                                Admin view
                            </button>
                            <div className="user-menu-sep" />
                        </>
                    )}
                    <button type="button" className="user-menu-item" role="menuitem"
                        onClick={() => { setOpen(false); setModal('password'); }}>
                        Change password
                    </button>
                    <button type="button" className="user-menu-item user-menu-item-danger" role="menuitem"
                        onClick={() => { setOpen(false); setModal('delete'); }}>
                        Delete account
                    </button>
                    <div className="user-menu-sep" />
                    <button type="button" className="user-menu-item" role="menuitem" onClick={logout}>
                        Log out
                    </button>
                </div>
            )}

            {modal === 'password' && <ChangePasswordModal onClose={() => setModal(null)} />}
            {modal === 'delete' && <DeleteAccountModal user={user} onClose={() => setModal(null)} />}
        </div>
    );
}

function ChangePasswordModal({ onClose }) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    async function onSubmit(e) {
        e.preventDefault();
        setError('');
        if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
        if (next !== confirm) { setError('The new passwords do not match.'); return; }
        setBusy(true);
        const { ok, data } = await changePassword({ currentPassword: current, newPassword: next });
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not change the password.'); return; }
        setDone(true);
    }

    return (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cp-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal-box">
                <h2 className="modal-title" id="cp-title">Change password</h2>
                {done ? (
                    <>
                        <p className="modal-message">Your password has been updated.</p>
                        <div className="modal-actions">
                            <button className="modal-confirm-btn modal-confirm-primary" onClick={onClose}>Done</button>
                        </div>
                    </>
                ) : (
                    <form className="modal-form" onSubmit={onSubmit}>
                        <label className="modal-field">
                            <span>Current password</span>
                            <input className="auth-input" type="password" autoComplete="current-password" autoFocus
                                value={current} onChange={(e) => setCurrent(e.target.value)} required />
                        </label>
                        <label className="modal-field">
                            <span>New password</span>
                            <input className="auth-input" type="password" autoComplete="new-password"
                                value={next} onChange={(e) => setNext(e.target.value)} required />
                        </label>
                        <label className="modal-field">
                            <span>Confirm new password</span>
                            <input className="auth-input" type="password" autoComplete="new-password"
                                value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                        </label>
                        {error && <p className="auth-error">{error}</p>}
                        <div className="modal-actions">
                            <button type="button" className="modal-cancel-btn" onClick={onClose}>Cancel</button>
                            <button type="submit" className="modal-confirm-btn modal-confirm-primary" disabled={busy}>
                                {busy ? 'Saving…' : 'Update password'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}

function DeleteAccountModal({ user, onClose }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const nameMatches = username.trim() === (user.username || '');

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    async function onSubmit(e) {
        e.preventDefault();
        setError('');
        if (!nameMatches) { setError('The username does not match your account.'); return; }
        setBusy(true);
        const { ok, data } = await deleteAccount({ username: username.trim(), password });
        if (!ok) { setBusy(false); setError(data.error || 'Could not delete the account.'); return; }
        // Account is gone — drop to the login screen.
        window.location.reload();
    }

    return (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="da-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal-box">
                <h2 className="modal-title" id="da-title">Delete account</h2>
                <p className="modal-message">
                    This is permanent. Your account, all your sigils and your agent tokens will be
                    erased and cannot be recovered.
                </p>
                <form className="modal-form" onSubmit={onSubmit}>
                    <label className="modal-field">
                        <span>Type your username <strong>{user.username}</strong> to confirm</span>
                        <input className="auth-input" type="text" autoComplete="off" autoFocus
                            value={username} onChange={(e) => setUsername(e.target.value)} required />
                    </label>
                    <label className="modal-field">
                        <span>Current password</span>
                        <input className="auth-input" type="password" autoComplete="current-password"
                            value={password} onChange={(e) => setPassword(e.target.value)} required />
                    </label>
                    {error && <p className="auth-error">{error}</p>}
                    <div className="modal-actions">
                        <button type="button" className="modal-cancel-btn" onClick={onClose}>Cancel</button>
                        <button type="submit" className="modal-confirm-btn modal-confirm-danger"
                            disabled={busy || !nameMatches || !password}>
                            {busy ? 'Deleting…' : 'Delete forever'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
