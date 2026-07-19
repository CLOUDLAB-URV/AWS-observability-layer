import { useEffect, useRef, useState } from 'react';
import { logout } from './auth.js';
import ConnectAgentModal from './ConnectAgentModal.jsx';
import UserSettingsModal from './UserSettingsModal.jsx';

// Profile menu in the top bar: the avatar + name is a trigger that opens a dropdown with the
// account actions (Connect agent, Options, Log out). All account settings — username, avatar,
// password, tokens, delete account — live in the tabbed Options modal (UserSettingsModal).
// Admins additionally get an "Admin view" entry (server-enforced — the menu gating is only UX).
export default function UserMenu({ user, onUserChange, onOpenAdmin }) {
    const [open, setOpen] = useState(false);
    const [modal, setModal] = useState(null); // null | 'connect' | 'options'
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
                <span className="user-avatar user-avatar-fallback" aria-hidden="true">
                    {user.avatar ? <img className="user-avatar-img" src={user.avatar} alt="" /> : initial}
                </span>
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
                    <button type="button" className="user-menu-item" role="menuitem"
                        onClick={() => { setOpen(false); setModal('connect'); }}>
                        Connect agent
                    </button>
                    <div className="user-menu-sep" />
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
                        onClick={() => { setOpen(false); setModal('options'); }}>
                        Options
                    </button>
                    <div className="user-menu-sep" />
                    <button type="button" className="user-menu-item" role="menuitem" onClick={logout}>
                        Log out
                    </button>
                </div>
            )}

            {modal === 'connect' && <ConnectAgentModal onClose={() => setModal(null)} />}
            {modal === 'options' && (
                <UserSettingsModal
                    user={user}
                    onUserChange={onUserChange}
                    onClose={() => setModal(null)}
                    onOpenConnect={() => setModal('connect')}
                />
            )}
        </div>
    );
}
