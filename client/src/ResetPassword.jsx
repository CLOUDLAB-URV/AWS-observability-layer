import { useState } from 'react';
import { resetPassword } from './auth.js';

// Standalone page reached from the password-reset email link (`/reset?token=…`). Sets a new
// password, then sends the user back to sign in. Reuses the full-screen auth styling.
export default function ResetPassword({ token }) {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);

    function backToSignIn() {
        window.location.assign('/');
    }

    async function onSubmit(e) {
        e.preventDefault();
        setError('');
        if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
        if (password !== confirm) { setError('The passwords do not match.'); return; }
        setBusy(true);
        const { ok, data } = await resetPassword({ token, password });
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not reset the password.'); return; }
        setDone(true);
    }

    return (
        <div className="auth-screen">
            <div className="auth-card">
                <div className="auth-brand">AWS Architect</div>
                {done ? (
                    <div className="auth-form">
                        <p className="auth-verify-lead">Your password has been reset. You can now sign in with it.</p>
                        <button className="auth-submit" type="button" onClick={backToSignIn}>Back to sign in</button>
                    </div>
                ) : (
                    <form className="auth-form" onSubmit={onSubmit}>
                        <p className="auth-verify-lead">Choose a new password for your account.</p>
                        <label className="auth-field">
                            <span>New password</span>
                            <input className="auth-input" type="password" autoComplete="new-password" autoFocus
                                value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        <label className="auth-field">
                            <span>Confirm new password</span>
                            <input className="auth-input" type="password" autoComplete="new-password"
                                value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                        </label>
                        {error && <p className="auth-error">{error}</p>}
                        <button className="auth-submit" type="submit" disabled={busy}>
                            {busy ? 'Saving…' : 'Reset password'}
                        </button>
                        <p className="auth-switch">
                            <button type="button" className="auth-link" onClick={backToSignIn}>Back to sign in</button>
                        </p>
                    </form>
                )}
            </div>
        </div>
    );
}
