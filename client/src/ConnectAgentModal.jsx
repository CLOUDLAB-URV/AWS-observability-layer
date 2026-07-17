import { useEffect, useRef, useState } from 'react';

const TOKEN_LIMIT = 3;
const AGENT_KEY = 'viz-connect-agent';

// Ready-to-paste MCP setup / removal commands for a given token + agent. `dev` targets the
// local backend with a coexisting "-local" server name; prod uses the published helpers with a
// per-OS-user name ($USER expands when pasted into a shell).
function buildCommands({ token, dev, visualizerUrl }) {
    const serverName = dev ? 'sigilum-local' : 'sigilum-$USER';
    const claudeUrlFlag = dev && visualizerUrl ? `\n    --env SIGILUM_URL=${visualizerUrl} \\` : '';
    const claudeAdd = `claude mcp add --scope user ${serverName} \\
    --env SIGILUM_TOKEN=${token} \\${claudeUrlFlag}
    -- npx -y sigilum-mcp@latest`;
    const claudeRemove = `claude mcp remove --scope user ${serverName}`;

    const opencodeDevSnippet = `"sigilum-local": {
  "type": "local",
  "command": ["npx", "-y", "sigilum-mcp@latest"],
  "enabled": true,
  "environment": {
    "SIGILUM_TOKEN": "${token}",
    "SIGILUM_URL": "${visualizerUrl}"
  }
}`;
    const urlEnv = dev && visualizerUrl ? ` SIGILUM_URL=${visualizerUrl}` : '';
    const opencodeAdd = dev
        ? opencodeDevSnippet
        : `SIGILUM_TOKEN=${token}${urlEnv} npx -y sigilum-opencode-setup`;
    const opencodeRemove = 'npx -y sigilum-opencode-setup --uninstall';

    return {
        opencode: { add: opencodeAdd, remove: opencodeRemove, addIsSnippet: dev },
        claude: { add: claudeAdd, remove: claudeRemove, addIsSnippet: false }
    };
}

// The next "Token N" default name: the smallest N ≥ 1 not already used by an existing
// "Token N" label, so auto-named tokens never collide.
function nextDefaultName(tokens) {
    const used = new Set(
        tokens
            .map((t) => /^Token (\d+)$/.exec((t.label || '').trim()))
            .filter(Boolean)
            .map((m) => Number(m[1]))
    );
    let n = 1;
    while (used.has(n)) n += 1;
    return `Token ${n}`;
}

function CopyBlock({ text, snippet }) {
    const [copied, setCopied] = useState(false);
    function copy() {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }
    return (
        <div className="cmd-block">
            <button type="button" className={`copy-btn ${copied ? 'is-copied' : ''}`} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
            </button>
            <pre className={`mcp-snippet ${snippet ? 'is-snippet' : ''}`}>{text}</pre>
        </div>
    );
}

// Segmented control to pick the target agent (opencode | Claude Code).
function AgentToggle({ agent, setAgent }) {
    return (
        <div className="ca-segment" role="tablist" aria-label="Choose your agent">
            {[['opencode', 'opencode'], ['claude', 'Claude Code']].map(([id, label]) => (
                <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={agent === id}
                    className={`ca-segment-btn ${agent === id ? 'is-active' : ''}`}
                    onClick={() => setAgent(id)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

// "Connect agent" pop-up. Two views: `list` (generate a token / manage existing ones) and
// `reveal` (shown once right after generating — the token plus ready-to-paste agent commands).
// Self-contained: it fetches /api/tokens itself and doesn't depend on the sigils context.
export default function ConnectAgentModal({ onClose }) {
    const [loading, setLoading] = useState(true);
    const [dev, setDev] = useState(false);
    const [devToken, setDevToken] = useState('');
    const [visualizerUrl, setVisualizerUrl] = useState('');
    const [tokens, setTokens] = useState([]);
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    // reveal-view state: the freshly generated token (secret, held in memory only).
    const [revealToken, setRevealToken] = useState('');
    const [confirmRevoke, setConfirmRevoke] = useState('');   // token id whose revoke confirm is open
    const [agent, setAgent] = useState(() => {
        try { return localStorage.getItem(AGENT_KEY) === 'claude' ? 'claude' : 'opencode'; }
        catch { return 'opencode'; }
    });
    const dialogRef = useRef(null);

    useEffect(() => {
        try { localStorage.setItem(AGENT_KEY, agent); } catch { /* quota */ }
    }, [agent]);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    async function loadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            setDev(Boolean(data.dev));
            setDevToken(data.devToken || '');
            setVisualizerUrl(data.visualizerUrl || '');
            setTokens(Array.isArray(data.tokens) ? data.tokens : []);
        } catch {
            setTokens([]);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => { loadTokens(); }, []);

    const atLimit = !dev && tokens.length >= TOKEN_LIMIT;

    async function generate() {
        setError('');
        if (atLimit) return;
        setBusy(true);
        try {
            const res = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ label: name.trim() || nextDefaultName(tokens) })
            });
            if (res.status === 409) {
                setError(`Token limit reached (${TOKEN_LIMIT}). Revoke one to add a new token.`);
                setBusy(false);
                return;
            }
            const data = await res.json();
            setBusy(false);
            if (!res.ok || !data.token) {
                setError(data.error || 'Could not generate a token. Try again.');
                return;
            }
            setName('');
            setRevealToken(data.token);
            loadTokens();
        } catch {
            setBusy(false);
            setError('Could not generate a token. Try again.');
        }
    }

    async function revoke(id) {
        try {
            await fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch { /* the reload reflects real state */ }
        setConfirmRevoke('');
        loadTokens();
    }

    function backToList() {
        setRevealToken('');
        setError('');
    }

    const inReveal = Boolean(revealToken);
    // Local dev has a single fixed token that's always present — build its commands up front so the
    // modal can show the token + ready-to-paste config directly, with nothing to generate.
    const cmdToken = dev ? devToken : revealToken;
    const cmds = (dev || inReveal) ? buildCommands({ token: cmdToken, dev, visualizerUrl }) : null;
    const active = cmds ? cmds[agent] : null;
    // Removal commands for the list-view "Disconnect" (token value not needed to remove).
    const removeCmds = buildCommands({ token: '', dev, visualizerUrl });

    return (
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ca-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal-box modal-box-wide" ref={dialogRef}>
                <div className="ca-head">
                    <h2 className="modal-title" id="ca-title">Connect agent</h2>
                    <button type="button" className="rd-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>

                {loading ? (
                    <p className="modal-message">Loading…</p>
                ) : dev ? (
                    <div className="ca-body">
                        <p className="ca-intro">
                            Local dev uses a single fixed token — no login, nothing to generate. Paste
                            one command into your agent and it connects to this local Sigilum. After each
                            change your agent reports what it deployed and the sigil updates live here.
                        </p>

                        <div className="ca-field-label">Your token</div>
                        <div className="ca-token">{devToken}</div>

                        <div className="ca-field-label ca-field-label-spaced">
                            Configure your agent
                            <AgentToggle agent={agent} setAgent={setAgent} />
                        </div>
                        <p className="ca-hint">
                            {agent === 'opencode'
                                ? (active.addIsSnippet
                                    ? <>Add this under <code>mcp</code> in <code>~/.config/opencode/opencode.json</code>. The token is already included.</>
                                    : <>Paste this in your terminal — it installs opencode if needed and writes the MCP config. The token is already included.</>)
                                : <>Paste this in your terminal. User scope = loaded in every session on this machine. The token is already included.</>}
                        </p>
                        <CopyBlock text={active.add} snippet={active.addIsSnippet} />

                        {/* Global MCP removal — idempotent, safe even if Sigilum was never configured. */}
                        <div className="ca-remove">
                            <div className="ca-field-label ca-field-label-spaced">
                                Remove Sigilum from your agent
                                <AgentToggle agent={agent} setAgent={setAgent} />
                            </div>
                            <p className="ca-hint">
                                {agent === 'opencode'
                                    ? <>Deletes the <code>sigilum</code> entry from <code>~/.config/opencode/opencode.json</code> if it's there — safe to run even if it was never set up.</>
                                    : <>Removes the user-scope <code>sigilum</code> MCP registration — safe to run even if it isn't registered.</>}
                            </p>
                            <CopyBlock text={removeCmds[agent].remove} />
                        </div>
                    </div>
                ) : inReveal ? (
                    <div className="ca-body">
                        <div className="ca-warning" role="alert">
                            <strong>Save this now.</strong> This token is shown only once — once you
                            close this window it can't be seen again (generate a new one if you lose it).
                        </div>

                        <div className="ca-field-label">Your token</div>
                        <div className="ca-token">{revealToken}</div>

                        <div className="ca-field-label ca-field-label-spaced">
                            Configure your agent
                            <AgentToggle agent={agent} setAgent={setAgent} />
                        </div>
                        <p className="ca-hint">
                            {agent === 'opencode'
                                ? (active.addIsSnippet
                                    ? <>Add this under <code>mcp</code> in <code>~/.config/opencode/opencode.json</code>. The token is already included.</>
                                    : <>Paste this in your terminal — it installs opencode if needed and writes the MCP config. The token is already included.</>)
                                : <>Paste this in your terminal. User scope = loaded in every session on this machine. The token is already included.</>}
                        </p>
                        <CopyBlock text={active.add} snippet={active.addIsSnippet} />

                        <div className="ca-actions">
                            <button type="button" className="btn btn-primary" onClick={backToList}>Done</button>
                        </div>
                    </div>
                ) : (
                    <div className="ca-body">
                        <p className="ca-intro">
                            Generate a token, then paste one command into your agent. After each change
                            your agent reports what it deployed and the sigil updates live here.
                        </p>

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

                        <div className="ca-generate">
                            <input
                                type="text"
                                className="ca-name-input"
                                placeholder={nextDefaultName(tokens)}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !atLimit) generate(); }}
                                disabled={atLimit}
                                aria-label="Token name"
                                maxLength={40}
                            />
                        </div>

                        <div className="ca-actions">
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={generate}
                                disabled={busy || atLimit}
                            >
                                {busy ? 'Generating…' : 'Generate token'}
                            </button>
                            <span className="ca-count">{tokens.length}/{TOKEN_LIMIT} tokens</span>
                        </div>
                        {atLimit && <p className="token-hint">Limit reached ({TOKEN_LIMIT}). Revoke one to add a new token.</p>}
                        {error && <p className="token-hint token-danger">{error}</p>}

                        {/* Global MCP removal — always available, no token or prior setup needed.
                            The command is idempotent: it's safe to run even if Sigilum was never
                            configured on this machine. */}
                        <div className="ca-remove">
                            <div className="ca-field-label ca-field-label-spaced">
                                Remove Sigilum from your agent
                                <AgentToggle agent={agent} setAgent={setAgent} />
                            </div>
                            <p className="ca-hint">
                                {agent === 'opencode'
                                    ? <>Deletes the <code>sigilum</code> entry from <code>~/.config/opencode/opencode.json</code> if it's there — safe to run even if it was never set up.</>
                                    : <>Removes the user-scope <code>sigilum</code> MCP registration — safe to run even if it isn't registered.</>}
                            </p>
                            <CopyBlock text={removeCmds[agent].remove} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
