import { useEffect, useRef, useState } from 'react';
import { register, verify, resend, login, forgotPassword } from './auth.js';

// Full-screen auth gate: Sign in / Create account, plus an email verification step and a
// forgot-password request. On success it reloads so main.jsx re-fetches the session and
// renders the app.

export default function Auth() {
    const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'verify' | 'forgot'
    const [identifier, setIdentifier] = useState('');
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [code, setCode] = useState('');
    const [pendingEmail, setPendingEmail] = useState('');
    const [devCode, setDevCode] = useState('');
    const [forgotEmail, setForgotEmail] = useState('');
    const [forgotSent, setForgotSent] = useState(false);
    const [devResetUrl, setDevResetUrl] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [cooldown, setCooldown] = useState(0);

    useEffect(() => {
        if (cooldown <= 0) return undefined;
        const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
        return () => clearTimeout(t);
    }, [cooldown]);

    function switchMode(next) {
        setMode(next);
        setError('');
        setNotice('');
        if (next === 'forgot') { setForgotSent(false); setDevResetUrl(''); }
    }

    async function onForgot(e) {
        e.preventDefault();
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await forgotPassword(forgotEmail);
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not send the email.'); return; }
        setDevResetUrl(data.devResetUrl || '');
        setForgotSent(true);
    }

    async function onSignup(e) {
        e.preventDefault();
        setError(''); setNotice('');
        if (password !== confirm) { setError('Passwords do not match.'); return; }
        setBusy(true);
        const { ok, data } = await register({ email, username, password });
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not create the account.'); return; }
        setPendingEmail(data.email || email);
        setDevCode(data.devCode || '');
        setCode('');
        setCooldown(30);
        setMode('verify');
        setNotice(`We sent a 6-digit code to ${data.email || email}.`);
    }

    async function onSignin(e) {
        e.preventDefault();
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await login({ identifier, password });
        setBusy(false);
        if (ok) { window.location.reload(); return; }
        if (data.needsVerify) {
            setPendingEmail(data.email || '');
            setDevCode(data.devCode || '');
            setCode('');
            setCooldown(30);
            setMode('verify');
            setNotice('Your email isn\'t verified yet — we sent you a new code.');
            return;
        }
        setError(data.error || 'Could not sign in.');
    }

    async function onVerify(e) {
        e.preventDefault();
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await verify({ email: pendingEmail, code });
        setBusy(false);
        if (ok) { window.location.reload(); return; }
        setError(data.error || 'Could not verify the code.');
    }

    async function onResend() {
        if (cooldown > 0 || busy) return;
        setError(''); setNotice('');
        setBusy(true);
        const { ok, data } = await resend(pendingEmail);
        setBusy(false);
        if (!ok) { setError(data.error || 'Could not resend the code.'); return; }
        setDevCode(data.devCode || '');
        setCooldown(30);
        setNotice('A new code is on its way.');
    }

    return (
        <div className="auth-screen">
            <div className="auth-card">
                <div className="auth-brand">AWS Architect</div>

                {mode !== 'verify' && mode !== 'forgot' && (
                    <div className="auth-tabs" role="tablist">
                        <button type="button" role="tab" aria-selected={mode === 'signin'}
                            className={`auth-tab ${mode === 'signin' ? 'is-active' : ''}`}
                            onClick={() => switchMode('signin')}>Sign in</button>
                        <button type="button" role="tab" aria-selected={mode === 'signup'}
                            className={`auth-tab ${mode === 'signup' ? 'is-active' : ''}`}
                            onClick={() => switchMode('signup')}>Create account</button>
                    </div>
                )}

                {mode === 'signin' && (
                    <form className="auth-form" onSubmit={onSignin}>
                        <label className="auth-field">
                            <span>Email or username</span>
                            <input className="auth-input" type="text" autoComplete="username" autoFocus
                                value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
                        </label>
                        <label className="auth-field">
                            <span>Password</span>
                            <input className="auth-input" type="password" autoComplete="current-password"
                                value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        {error && <p className="auth-error">{error}</p>}
                        <button className="auth-submit" type="submit" disabled={busy}>
                            {busy ? 'Signing in…' : 'Sign in'}
                        </button>
                        <p className="auth-switch">
                            <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>Forgot password?</button>
                        </p>
                        <p className="auth-switch">
                            No account?{' '}
                            <button type="button" className="auth-link" onClick={() => switchMode('signup')}>Create one</button>
                        </p>
                    </form>
                )}

                {mode === 'signup' && (
                    <form className="auth-form" onSubmit={onSignup}>
                        <label className="auth-field">
                            <span>Username</span>
                            <input className="auth-input" type="text" autoComplete="username" autoFocus
                                value={username} onChange={(e) => setUsername(e.target.value)} required />
                        </label>
                        <label className="auth-field">
                            <span>Email</span>
                            <input className="auth-input" type="email" autoComplete="email"
                                value={email} onChange={(e) => setEmail(e.target.value)} required />
                        </label>
                        <label className="auth-field">
                            <span>Password</span>
                            <input className="auth-input" type="password" autoComplete="new-password"
                                value={password} onChange={(e) => setPassword(e.target.value)} required />
                        </label>
                        <label className="auth-field">
                            <span>Confirm password</span>
                            <input className="auth-input" type="password" autoComplete="new-password"
                                value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                        </label>
                        {error && <p className="auth-error">{error}</p>}
                        <button className="auth-submit" type="submit" disabled={busy}>
                            {busy ? 'Creating…' : 'Create account'}
                        </button>
                        <p className="auth-switch">
                            Already have an account?{' '}
                            <button type="button" className="auth-link" onClick={() => switchMode('signin')}>Sign in</button>
                        </p>
                    </form>
                )}

                {mode === 'verify' && (
                    <form className="auth-form" onSubmit={onVerify}>
                        <p className="auth-verify-lead">
                            Enter the 6-digit code we sent to <strong>{pendingEmail}</strong>.
                        </p>
                        <CodeInput value={code} onChange={setCode} onComplete={() => {}} />
                        {devCode && (
                            <p className="auth-dev">Dev mode (no email configured): your code is <code>{devCode}</code></p>
                        )}
                        {error && <p className="auth-error">{error}</p>}
                        {notice && !error && <p className="auth-notice">{notice}</p>}
                        <button className="auth-submit" type="submit" disabled={busy || code.length !== 6}>
                            {busy ? 'Verifying…' : 'Verify & continue'}
                        </button>
                        <p className="auth-switch">
                            Didn't get it?{' '}
                            <button type="button" className="auth-link" onClick={onResend} disabled={cooldown > 0 || busy}>
                                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                            </button>
                            {' · '}
                            <button type="button" className="auth-link" onClick={() => switchMode('signin')}>Back</button>
                        </p>
                    </form>
                )}

                {mode === 'forgot' && (
                    forgotSent ? (
                        <div className="auth-form">
                            <p className="auth-verify-lead">
                                If an account exists for <strong>{forgotEmail}</strong>, we've sent a link to
                                reset your password. Check your inbox.
                            </p>
                            {devResetUrl && (
                                <p className="auth-dev">Dev mode (no email configured): <a className="auth-link" href={devResetUrl}>open reset link</a></p>
                            )}
                            <p className="auth-switch">
                                <button type="button" className="auth-link" onClick={() => switchMode('signin')}>Back to sign in</button>
                            </p>
                        </div>
                    ) : (
                        <form className="auth-form" onSubmit={onForgot}>
                            <p className="auth-verify-lead">
                                Enter your account email and we'll send you a link to reset your password.
                            </p>
                            <label className="auth-field">
                                <span>Email</span>
                                <input className="auth-input" type="email" autoComplete="email" autoFocus
                                    value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} required />
                            </label>
                            {error && <p className="auth-error">{error}</p>}
                            <button className="auth-submit" type="submit" disabled={busy}>
                                {busy ? 'Sending…' : 'Send reset link'}
                            </button>
                            <p className="auth-switch">
                                <button type="button" className="auth-link" onClick={() => switchMode('signin')}>Back to sign in</button>
                            </p>
                        </form>
                    )
                )}

                {mode !== 'verify' && mode !== 'forgot' && notice && !error && <p className="auth-notice">{notice}</p>}
            </div>
        </div>
    );
}

// Six segmented inputs that behave like one code field (paste-aware, auto-advance, backspace).
function CodeInput({ value, onChange }) {
    const refs = useRef([]);
    const digits = value.padEnd(6, ' ').slice(0, 6).split('');

    function setAt(i, d) {
        const arr = value.padEnd(6, ' ').slice(0, 6).split('');
        arr[i] = d;
        onChange(arr.join('').replace(/\s/g, ''));
    }

    function onKey(i, e) {
        if (e.key === 'Backspace') {
            e.preventDefault();
            if (digits[i].trim()) {
                setAt(i, ' ');
            } else if (i > 0) {
                refs.current[i - 1]?.focus();
                setAt(i - 1, ' ');
            }
        } else if (/^\d$/.test(e.key)) {
            e.preventDefault();
            setAt(i, e.key);
            refs.current[i + 1]?.focus();
        }
    }

    function onPaste(e) {
        const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (text) {
            e.preventDefault();
            onChange(text);
            refs.current[Math.min(text.length, 5)]?.focus();
        }
    }

    return (
        <div className="auth-code" onPaste={onPaste}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
                <input
                    key={i}
                    ref={(el) => { refs.current[i] = el; }}
                    className="auth-code-box"
                    inputMode="numeric"
                    maxLength={1}
                    autoFocus={i === 0}
                    value={digits[i].trim()}
                    onChange={() => {}}
                    onKeyDown={(e) => onKey(i, e)}
                    aria-label={`Digit ${i + 1}`}
                />
            ))}
        </div>
    );
}
