import { useEffect, useState } from 'react';
import { formatTokens } from './format.js';

// Runtime limits editor: max accounts, max sigils per user, max MCP tokens per user.
// Values save through PUT /api/admin/settings and persist on the server's durable
// volume (they survive redeploys/migrations); env vars are only the bootstrap
// defaults. "Reset" removes the admin override and falls back to that default.
// Admin accounts are exempt from every one of these limits.

const FIELDS = [
    { key: 'maxUsers', label: 'Accounts (total)', hint: 'Registrations blocked past this.' },
    { key: 'maxSigilsPerUser', label: 'Sigils per user', hint: 'New sigil pushes rejected past this.' },
    { key: 'maxTokensPerUser', label: 'Tokens per user', hint: 'MCP tokens each user may hold.' },
    { key: 'maxLlmTokensPerUserPerMonth', label: 'AI tokens / user / month', hint: 'Gemini spend cap; resets on the 1st.' }
];

async function fetchSettings() {
    const res = await fetch('/api/admin/settings', { headers: { Accept: 'application/json' } });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, data };
}

async function putSettings(patch) {
    const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(patch)
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, data };
}

export default function AdminLimits({ onSaved }) {
    const [settings, setSettings] = useState(null); // key → { value, source, default, max }
    const [drafts, setDrafts] = useState({});       // key → input string while editing
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    async function load() {
        const { ok, data } = await fetchSettings();
        if (ok) {
            setSettings(data.settings);
            setDrafts({});
            setError(null);
        } else {
            setError(data.error || 'Could not load limits.');
        }
    }

    useEffect(() => { load(); }, []);

    async function apply(patch) {
        setBusy(true);
        setError(null);
        const { ok, data } = await putSettings(patch);
        setBusy(false);
        if (!ok) {
            setError(data.error || 'Could not save.');
            return;
        }
        setSettings(data.settings);
        setDrafts({});
        onSaved?.();
    }

    function save() {
        const patch = {};
        for (const [key, raw] of Object.entries(drafts)) {
            if (raw !== '' && Number(raw) !== settings[key].value) {
                patch[key] = Number(raw);
            }
        }
        if (Object.keys(patch).length > 0) {
            apply(patch);
        }
    }

    if (!settings) {
        return <div className="admin-limits"><div className="admin-detail-hint">{error || 'Loading limits…'}</div></div>;
    }

    const dirty = Object.entries(drafts).some(([key, raw]) => raw !== '' && Number(raw) !== settings[key].value);

    return (
        <div className="admin-limits">
            <div className="admin-limits-head">
                <h3 className="admin-limits-title">Limits</h3>
                <span className="admin-limits-note">Persisted on the server — survive redeploys. Admins are exempt.</span>
            </div>
            <div className="admin-limits-grid">
                {FIELDS.map(({ key, label, hint }) => {
                    const s = settings[key];
                    return (
                        <div key={key} className="admin-limit-field">
                            <label className="admin-limit-label" htmlFor={`limit-${key}`}>{label}</label>
                            <div className="admin-limit-row">
                                <input
                                    id={`limit-${key}`}
                                    type="number"
                                    min="1"
                                    max={s.max}
                                    value={drafts[key] ?? String(s.value)}
                                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                                    disabled={busy}
                                />
                                {s.source === 'admin' ? (
                                    <button
                                        type="button"
                                        className="link-btn admin-limit-reset"
                                        onClick={() => apply({ [key]: null })}
                                        disabled={busy}
                                        title={`Remove the override and fall back to ${s.default}`}
                                    >
                                        Reset to {formatTokens(s.default)}
                                    </button>
                                ) : (
                                    <span className="admin-limit-source">{s.source === 'env' ? 'env default' : 'default'}</span>
                                )}
                            </div>
                            <span className="admin-limit-hint">{hint}</span>
                        </div>
                    );
                })}
                <div className="admin-limit-actions">
                    <button type="button" className="admin-limit-save" onClick={save} disabled={busy || !dirty}>
                        {busy ? 'Saving…' : 'Save limits'}
                    </button>
                    {error && <span className="admin-limit-error">{error}</span>}
                </div>
            </div>
        </div>
    );
}
