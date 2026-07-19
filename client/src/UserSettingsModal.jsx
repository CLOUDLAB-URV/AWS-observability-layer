import { useEffect, useRef, useState } from 'react';
import {
    changePassword, changeUsername, deleteAccount, forgotPassword,
    loadMyUsage, logoutAll, setAvatar
} from './auth.js';

// "Options" pop-up — the account settings, as a tabbed modal on the shared shell
// (.modal-box-wide + .ca-head + .ca-segment + .ca-body). Tabs: Profile (avatar, username,
// account info), Security (change password, log out everywhere), Usage (LLM quota, sigils,
// agent tokens) and Danger zone (delete account).

const TABS = [
    ['profile', 'Profile'],
    ['security', 'Security'],
    ['usage', 'Usage'],
    ['danger', 'Danger zone']
];

const AVATAR_SIZE = 128;

// Downscale a picked image file to a small square JPEG data URL (center-crop cover), so the
// avatar travels as a few-KB JSON string — no upload infrastructure needed.
async function fileToAvatar(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('unreadable image'));
            i.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext('2d');
        // JPEG has no alpha — flatten transparent PNGs onto white instead of black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function fmtDate(iso) {
    const t = Date.parse(iso ?? '');
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const fmtNum = (n) => new Intl.NumberFormat().format(Number(n) || 0);

export default function UserSettingsModal({ user, onUserChange, onClose, onOpenConnect }) {
    const [tab, setTab] = useState('profile');

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="us-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal-box modal-box-wide us-box">
                <div className="ca-head">
                    <h2 className="modal-title" id="us-title">
                        <svg className="so-title-icon" viewBox="0 0 24 24" width="17" height="17" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            aria-hidden="true">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                        Options
                    </h2>
                    <button type="button" className="rd-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="us-layout">
                    <nav className="us-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
                        {TABS.map(([id, label]) => (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                aria-selected={tab === id}
                                className={`us-nav-btn ${tab === id ? 'is-active' : ''} ${id === 'danger' ? 'is-danger' : ''}`}
                                onClick={() => setTab(id)}
                            >
                                {label}
                            </button>
                        ))}
                    </nav>
                    <div className="ca-body us-panel">
                        {tab === 'profile' && <ProfileTab user={user} onUserChange={onUserChange} />}
                        {tab === 'security' && <SecurityTab user={user} />}
                        {tab === 'usage' && <UsageTab onOpenConnect={onOpenConnect} />}
                        {tab === 'danger' && <DangerTab user={user} />}
                    </div>
                </div>
            </div>
        </div>
    );
}

// --- Profile: avatar + username + read-only account info -----------------------------------
function ProfileTab({ user, onUserChange }) {
    const [name, setName] = useState(user.username || '');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const fileRef = useRef(null);

    const initial = (user.username || user.email || '?').trim().charAt(0).toUpperCase();
    const trimmed = name.trim();
    const canSave = trimmed.length > 0 && trimmed !== (user.username || '');

    async function saveUsername() {
        if (!canSave || busy) return;
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await changeUsername(trimmed);
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not change the username.'); return; }
        onUserChange?.(data.user);
        setNotice('Username updated.');
    }

    async function onPickFile(e) {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        if (!file || busy) return;
        setError(''); setNotice('');
        setBusy(true);
        try {
            const dataUrl = await fileToAvatar(file);
            const { ok, data } = await setAvatar(dataUrl);
            if (!ok) { setError(data.error || 'Could not update the profile picture.'); return; }
            onUserChange?.(data.user);
            setNotice('Profile picture updated.');
        } catch {
            setError('That file could not be read as an image.');
        } finally {
            setBusy(false);
        }
    }

    async function removeAvatar() {
        if (busy) return;
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await setAvatar(null);
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not remove the profile picture.'); return; }
        onUserChange?.(data.user);
        setNotice('Profile picture removed.');
    }

    return (
        <>
            <div className="ca-field-label">Profile picture</div>
            <div className="us-avatar-row">
                <span className="us-avatar" aria-hidden="true">
                    {user.avatar
                        ? <img className="user-avatar-img" src={user.avatar} alt="" />
                        : initial}
                </span>
                <div className="us-avatar-actions">
                    <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
                        Upload photo
                    </button>
                    {user.avatar && (
                        <button type="button" className="link-btn token-danger" onClick={removeAvatar} disabled={busy}>
                            Remove
                        </button>
                    )}
                    <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
                </div>
            </div>
            <p className="ca-hint">JPG, PNG or WebP — cropped to a square and resized in your browser.</p>

            <div className="ca-field-label ca-field-label-spaced">Username</div>
            <div className="so-name">
                <input
                    type="text"
                    className="ca-name-input"
                    value={name}
                    onChange={(e) => { setName(e.target.value); if (error) setError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveUsername(); }}
                    aria-label="Username"
                    maxLength={30}
                />
                <button type="button" className="btn btn-primary" onClick={saveUsername} disabled={!canSave || busy}>
                    Save
                </button>
            </div>
            {error && <p className="so-name-error" role="alert">{error}</p>}
            {notice && !error && <p className="auth-notice">{notice}</p>}

            <div className="ca-field-label ca-field-label-spaced">Account</div>
            <dl className="so-info">
                <div className="so-info-row">
                    <dt>Email</dt>
                    <dd>{user.email}</dd>
                </div>
                <div className="so-info-row">
                    <dt>Member since</dt>
                    <dd>{fmtDate(user.createdAt)}</dd>
                </div>
                <div className="so-info-row">
                    <dt>Last login</dt>
                    <dd>{fmtDate(user.lastLogin)}</dd>
                </div>
                <div className="so-info-row">
                    <dt>Role</dt>
                    <dd>{user.role === 'admin' ? 'Admin' : 'User'}</dd>
                </div>
            </dl>
        </>
    );
}

// --- Security: change password (with reset-link fallback) + log out everywhere -------------
function SecurityTab({ user }) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [resetSent, setResetSent] = useState(false);
    const [devResetUrl, setDevResetUrl] = useState('');
    const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);

    async function onSubmit(e) {
        e.preventDefault();
        setError(''); setNotice('');
        if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
        if (next !== confirm) { setError('The new passwords do not match.'); return; }
        setBusy(true);
        const { ok, data } = await changePassword({ currentPassword: current, newPassword: next });
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not change the password.'); return; }
        setCurrent(''); setNext(''); setConfirm('');
        setNotice('Your password has been updated.');
    }

    // Fallback for when the user doesn't remember their current password: email them the same
    // reset link the login screen's "Forgot password?" flow uses.
    async function onSendReset() {
        if (busy) return;
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await forgotPassword(user.email);
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not send the email.'); return; }
        setDevResetUrl(data.devResetUrl || '');
        setResetSent(true);
    }

    async function doLogoutAll() {
        setBusy(true);
        await logoutAll();
        // Every session (including this one) is gone — drop to the login screen.
        window.location.reload();
    }

    return (
        <>
            <div className="ca-field-label">Change password</div>
            {resetSent ? (
                <>
                    <p className="modal-message">
                        We've sent a reset link to <strong>{user.email}</strong>. Open it to choose
                        a new password.
                    </p>
                    {devResetUrl && (
                        <p className="auth-dev">Dev mode (no email configured): <a className="auth-link" href={devResetUrl}>open reset link</a></p>
                    )}
                </>
            ) : (
                <form className="modal-form" onSubmit={onSubmit}>
                    <label className="modal-field">
                        <span>Current password</span>
                        <input className="auth-input" type="password" autoComplete="current-password"
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
                    {notice && !error && <p className="auth-notice">{notice}</p>}
                    <div className="modal-actions">
                        <button type="submit" className="modal-confirm-btn modal-confirm-primary" disabled={busy}>
                            {busy ? 'Saving…' : 'Update password'}
                        </button>
                    </div>
                    <p className="auth-switch">
                        Don't remember your current password?{' '}
                        <button type="button" className="auth-link" onClick={onSendReset} disabled={busy}>
                            Email me a reset link
                        </button>
                    </p>
                </form>
            )}

            <div className="so-danger">
                <div className="so-danger-text">
                    <span className="so-danger-title">Log out everywhere</span>
                    <span className="so-danger-sub">Ends your session on every device, including this one.</span>
                </div>
                {confirmLogoutAll ? (
                    <span className="so-danger-confirm">
                        <span>Sure?</span>
                        <button type="button" className="btn btn-danger" onClick={doLogoutAll} disabled={busy}>
                            Log out
                        </button>
                        <button type="button" className="link-btn" onClick={() => setConfirmLogoutAll(false)}>Cancel</button>
                    </span>
                ) : (
                    <button type="button" className="btn btn-danger" onClick={() => setConfirmLogoutAll(true)}>
                        Log out everywhere
                    </button>
                )}
            </div>
        </>
    );
}

// --- Usage: LLM quota + sigils + agent tokens ----------------------------------------------
function UsageTab({ onOpenConnect }) {
    const [usage, setUsage] = useState(null);
    const [usageError, setUsageError] = useState('');
    const [tokens, setTokens] = useState([]);
    const [dev, setDev] = useState(false);
    const [tokensLoaded, setTokensLoaded] = useState(false);
    const [tokenName, setTokenName] = useState('');
    const [tokenError, setTokenError] = useState('');
    const [newToken, setNewToken] = useState('');   // freshly generated secret, shown once
    const [copied, setCopied] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        loadMyUsage().then(setUsage).catch(() => setUsageError('Could not load your usage.'));
        fetch('/api/tokens')
            .then((res) => res.json())
            .then((data) => {
                setDev(Boolean(data.dev));
                setTokens(Array.isArray(data.tokens) ? data.tokens : []);
            })
            .catch(() => setTokens([]))
            .finally(() => setTokensLoaded(true));
    }, []);

    async function reloadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            setTokens(Array.isArray(data.tokens) ? data.tokens : []);
        } catch { /* keep the current list */ }
    }

    async function generate() {
        if (busy) return;
        setTokenError('');
        setBusy(true);
        try {
            const res = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ label: tokenName.trim() || `Token ${tokens.length + 1}` })
            });
            const data = await res.json();
            if (!res.ok || !data.token) {
                setTokenError(data.error || 'Could not generate a token. Try again.');
                return;
            }
            setTokenName('');
            setNewToken(data.token);
            setCopied(false);
            reloadTokens();
        } catch {
            setTokenError('Could not generate a token. Try again.');
        } finally {
            setBusy(false);
        }
    }

    async function revoke(id) {
        try {
            await fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch { /* the reload reflects real state */ }
        setConfirmRevoke('');
        reloadTokens();
    }

    function copyToken() {
        navigator.clipboard?.writeText(newToken).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    const llmUsed = usage?.llm?.total ?? 0;
    const llmPct = usage && usage.llmLimit > 0 ? Math.min(100, (llmUsed / usage.llmLimit) * 100) : 0;

    return (
        <>
            <div className="ca-field-label">This month's AI usage</div>
            {usageError ? (
                <p className="token-hint token-danger">{usageError}</p>
            ) : !usage ? (
                <p className="ca-hint">Loading…</p>
            ) : (
                <>
                    <div className="us-usage-bar" role="meter" aria-valuemin={0} aria-valuemax={usage.llmLimit}
                        aria-valuenow={llmUsed} aria-label="LLM tokens used this month">
                        <div className={`us-usage-fill ${llmPct >= 80 ? 'is-hot' : ''}`} style={{ width: `${llmPct}%` }} />
                    </div>
                    <p className="us-usage-note">
                        <strong>{fmtNum(llmUsed)}</strong> of {fmtNum(usage.llmLimit)} LLM tokens
                        · {fmtNum(usage.llm?.calls)} call{(usage.llm?.calls ?? 0) === 1 ? '' : 's'} — resets on the 1st.
                    </p>
                    <p className="us-usage-note">
                        <strong>{fmtNum(usage.sigils)}</strong> of {fmtNum(usage.sigilLimit)} sigils used.
                    </p>
                </>
            )}

            <div className="ca-field-label ca-field-label-spaced">Agent tokens</div>
            {!tokensLoaded ? (
                <p className="ca-hint">Loading…</p>
            ) : dev ? (
                <p className="ca-hint">Local dev uses a single fixed token — open Connect agent for the setup commands.</p>
            ) : (
                <>
                    {newToken && (
                        <>
                            <div className="ca-warning" role="alert">
                                <strong>Save this now.</strong> This token is shown only once.
                            </div>
                            <div className="ca-token">{newToken}</div>
                            <div className="ca-actions">
                                <button type="button" className="btn btn-primary" onClick={copyToken}>
                                    {copied ? 'Copied' : 'Copy'}
                                </button>
                                <button type="button" className="link-btn" onClick={() => setNewToken('')}>Done</button>
                            </div>
                        </>
                    )}
                    {!newToken && (
                        <>
                            {tokens.length > 0 && (
                                <ul className="ca-token-list">
                                    {tokens.map((t) => (
                                        <li key={t.id} className="ca-token-item">
                                            <div className="ca-token-row">
                                                <span className="ca-token-name">{t.label || 'Untitled token'}</span>
                                                <code className="ca-token-preview">{t.tokenPreview}</code>
                                                {confirmRevoke === t.id ? (
                                                    <span className="ca-revoke-inline">
                                                        <span className="ca-revoke-q">Revoke?</span>
                                                        <button type="button" className="btn btn-danger" onClick={() => revoke(t.id)}>Revoke</button>
                                                        <button type="button" className="link-btn" onClick={() => setConfirmRevoke('')}>Cancel</button>
                                                    </span>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="link-btn token-danger"
                                                        onClick={() => setConfirmRevoke(t.id)}
                                                        title="Revoke this token — agents using it stop working"
                                                    >
                                                        Revoke
                                                    </button>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="so-name">
                                <input
                                    type="text"
                                    className="ca-name-input"
                                    placeholder="Token name"
                                    value={tokenName}
                                    onChange={(e) => setTokenName(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
                                    aria-label="Token name"
                                    maxLength={40}
                                />
                                <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
                                    {busy ? 'Generating…' : 'Generate'}
                                </button>
                            </div>
                            {tokenError && <p className="token-hint token-danger">{tokenError}</p>}
                        </>
                    )}
                    <p className="ca-hint">
                        Need the setup commands for your agent?{' '}
                        <button type="button" className="auth-link" onClick={onOpenConnect}>Open Connect agent</button>
                    </p>
                </>
            )}
        </>
    );
}

// --- Danger zone: delete account -----------------------------------------------------------
function DangerTab({ user }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const nameMatches = username.trim() === (user.username || '');

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
        <>
            <div className="ca-field-label">Delete account</div>
            <p className="modal-message">
                This is permanent. Your account, all your sigils and your agent tokens will be
                erased and cannot be recovered.
            </p>
            <form className="modal-form" onSubmit={onSubmit}>
                <label className="modal-field">
                    <span>Type your username <strong>{user.username}</strong> to confirm</span>
                    <input className="auth-input" type="text" autoComplete="off"
                        value={username} onChange={(e) => setUsername(e.target.value)} required />
                </label>
                <label className="modal-field">
                    <span>Current password</span>
                    <input className="auth-input" type="password" autoComplete="current-password"
                        value={password} onChange={(e) => setPassword(e.target.value)} required />
                </label>
                {error && <p className="auth-error">{error}</p>}
                <div className="modal-actions">
                    <button type="submit" className="modal-confirm-btn modal-confirm-danger"
                        disabled={busy || !nameMatches || !password}>
                        {busy ? 'Deleting…' : 'Delete forever'}
                    </button>
                </div>
            </form>
        </>
    );
}
