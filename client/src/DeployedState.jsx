import { useEffect, useRef, useState } from 'react';
import Diagram from './Diagram.jsx';
import ResourceDetail from './ResourceDetail.jsx';
import McpGuide from './McpGuide.jsx';
import { createSocket } from './ws.js';

const TOKEN_LIMIT = 3;
const TOKEN_PLACEHOLDER = 'viz_your_token_here';

// "Deployed state" view: subscribes to one chat on the visualizer socket and
// renders a live diagram of what is actually deployed in AWS (pushed from the
// user's agent via the MCP tool). Each chat has its own isolated diagram. Also
// hosts the API-token + MCP-config panel.
export default function DeployedState() {
    const [connected, setConnected] = useState(false);
    const [chats, setChats] = useState([]);
    const [chatId, setChatId] = useState('');
    const [svg, setSvg] = useState('');
    const [renderError, setRenderError] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [showGuide, setShowGuide] = useState(false);
    const [newToken, setNewToken] = useState('');
    const [tokens, setTokens] = useState([]);
    const [tokenError, setTokenError] = useState('');
    // Local dev: the backend reports a fixed env token + local URL instead of a generated-token
    // store. When `dev` is true the panel shows that token read-only (no generate/revoke).
    const [dev, setDev] = useState(false);
    const [devToken, setDevToken] = useState('');
    const [visualizerUrl, setVisualizerUrl] = useState('');
    const [confirmRevoke, setConfirmRevoke] = useState('');
    const [copied, setCopied] = useState('');
    const [renameValue, setRenameValue] = useState('');
    const [showDetails, setShowDetails] = useState(false);
    const [editingName, setEditingName] = useState(false);
    const [agent, setAgent] = useState('opencode'); // 'opencode' | 'claude'
    // Live resource inventory for the selected chat (powers per-service tooltips + the detail
    // panel), and the resource the user clicked in the diagram.
    const [resources, setResources] = useState([]);
    const [selectedResource, setSelectedResource] = useState(null);
    // Mode of the selected diagram: true = "Live" (deployed to AWS), false = "Design" (a sketch).
    const [deployed, setDeployed] = useState(false);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected, '/ws-visualizer');
        socketRef.current = socket;
        loadChats();
        loadTokens();
        return () => socket.close();
    }, []);

    // (Re)subscribe whenever the active chat changes or we (re)connect. With no chat
    // selected we show nothing — the diagram only loads once the user picks a chat.
    useEffect(() => {
        setSvg('');
        setRenderError(null);
        setSelectedResource(null);
        if (connected && chatId) {
            socketRef.current?.send({ type: 'subscribe', chatId });
        }
    }, [connected, chatId]);

    // Keep the resource inventory in sync with the selected chat: reload on chat change and
    // whenever a new diagram arrives (a push changed the deployed state). Reconcile the open
    // detail panel against the fresh data (update it, or close it if the resource is gone).
    useEffect(() => {
        if (!chatId) {
            setResources([]);
            setDeployed(false);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
                const data = await res.json();
                if (cancelled) return;
                const list = Array.isArray(data.resources) ? data.resources : [];
                setResources(list);
                setDeployed(data.deployed === true);
                setSelectedResource((cur) => (cur ? list.find((r) => r.id === cur.id) || null : null));
            } catch {
                if (!cancelled) setResources([]);
            }
        })();
        return () => { cancelled = true; };
    }, [chatId, svg]);

    // Keep the rename field in sync with the selected chat's current name, and leave
    // edit mode whenever the selected chat changes.
    useEffect(() => {
        const current = chats.find((c) => c.chatId === chatId);
        setRenameValue(current?.name || '');
        setEditingName(false);
    }, [chatId, chats]);

    function handleMessage(message) {
        switch (message.type) {
            case 'init':
            case 'render-svg':
                setSvg(message.svg || '');
                setRenderError(message.renderError || null);
                // A push may have created/updated a chat — refresh the list.
                loadChats();
                break;
            case 'error':
                setRenderError(message.message);
                break;
            default:
                break;
        }
    }

    async function loadChats() {
        try {
            const res = await fetch('/api/chats');
            const data = await res.json();
            const list = data.chats || [];
            setChats(list);
            // No auto-select: the diagram only appears once the user picks a chat.
        } catch {
            setChats([]);
        }
    }

    async function loadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            setTokens(Array.isArray(data.tokens) ? data.tokens : []);
            setDev(Boolean(data.dev));
            setDevToken(data.devToken || '');
            setVisualizerUrl(data.visualizerUrl || '');
        } catch {
            setTokens([]);
        }
    }

    async function generateToken() {
        setTokenError('');
        try {
            const res = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ label: 'web' })
            });
            if (res.status === 409) {
                setTokenError(`Limit reached (${TOKEN_LIMIT}) — revoke one to add a new token.`);
                return;
            }
            const data = await res.json();
            setNewToken(data.token || '');
            loadTokens();
        } catch {
            setTokenError('Could not generate a token. Try again.');
        }
    }

    async function revokeToken(id) {
        try {
            await fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch {
            // ignore — the list refresh below reflects the real state
        }
        setConfirmRevoke('');
        setTokenError('');
        loadTokens();
    }

    function openSettings() {
        setShowSettings((v) => !v);
        setShowGuide(false);
    }

    function openGuide() {
        setShowGuide((v) => !v);
        setShowSettings(false);
    }

    // Override the auto-assigned session name for the selected chat.
    async function renameChat() {
        const name = renameValue.trim();
        if (!chatId || !name) return;
        try {
            await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name })
            });
            setEditingName(false);
            loadChats();
        } catch {
            // ignore — the list simply won't update
        }
    }

    function startRename() {
        setRenameValue(selectedChat?.name || '');
        setEditingName(true);
    }

    function cancelRename() {
        setRenameValue(selectedChat?.name || '');
        setEditingName(false);
    }

    // The dropdown shows only the human name (fall back to a short id for unnamed
    // chats). Dates / full id / rename live in the Details panel below.
    function chatLabel(c) {
        return c.name || `Chat ${c.chatId.slice(0, 8)}`;
    }

    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    const selectedChat = chats.find((c) => c.chatId === chatId) || null;

    // Server name. In local dev use a distinct "-local" name + VISUALIZER_URL so this MCP targets
    // the local server and coexists with the hosted one a user already has. In production it's a
    // unique-per-OS-user name ($USER expands when pasted into a shell), safe to run anywhere.
    const SERVER_NAME = dev ? 'diagram-state-visualizer-local' : 'diagram-state-visualizer-$USER';
    // In dev the token is the fixed env one (always known). Otherwise use the freshly generated
    // token if we have one; the secret of an existing token is never returned to the UI, so a
    // ready-to-paste command is only possible right after generating it.
    const tokenForCmd = dev ? devToken : (newToken || TOKEN_PLACEHOLDER);
    // In dev, point the MCP at the local server; in prod it defaults to the hosted deployment.
    const urlEnv = dev && visualizerUrl ? ` VISUALIZER_URL=${visualizerUrl}` : '';
    const claudeUrlFlag = dev && visualizerUrl ? `\n    --env VISUALIZER_URL=${visualizerUrl} \\` : '';
    // Ready-to-paste Claude Code CLI command: registers the published MCP at user scope
    // (loaded in every session on this machine) with the token baked in.
    const claudeAddCommand = `claude mcp add --scope user ${SERVER_NAME} \\
    --env VISUALIZER_TOKEN=${tokenForCmd} \\${claudeUrlFlag}
    -- npx -y diagram-state-visualizer-mcp@latest`;
    const claudeRemoveCommand = `claude mcp remove --scope user ${SERVER_NAME}`;
    // opencode in production: one command that installs opencode if needed and writes the MCP entry
    // into ~/.config/opencode/opencode.json (idempotent — re-running only refreshes the token). The
    // token goes via env var (same name the MCP reads), so it's not stored as a CLI flag.
    // In dev we can't use that helper: it owns the single `diagram-state-visualizer` key, so it
    // would clobber a user's hosted entry. Show a manual `-local` entry instead, which coexists.
    const opencodeDevSnippet = `"diagram-state-visualizer-local": {
  "type": "local",
  "command": ["npx", "-y", "diagram-state-visualizer-mcp@latest"],
  "enabled": true,
  "environment": {
    "VISUALIZER_TOKEN": "${tokenForCmd}",
    "VISUALIZER_URL": "${visualizerUrl}"
  }
}`;
    const opencodeAddCommand = dev
        ? opencodeDevSnippet
        : `VISUALIZER_TOKEN=${tokenForCmd}${urlEnv} npx -y @apozo/opencode-diagrammer-setup`;
    // Per-agent values driving the single step-2 block below.
    const addCommand = agent === 'claude' ? claudeAddCommand : opencodeAddCommand;

    function copy(text, key) {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(key);
        setTimeout(() => setCopied((k) => (k === key ? '' : k)), 1500);
    }

    return (
        <div className="deployed-state">
            <div className="deployed-toolbar">
                <div className="project-form">
                    <label htmlFor="viz-chat">Chat</label>
                    <select
                        id="viz-chat"
                        value={chatId}
                        onChange={(e) => setChatId(e.target.value)}
                    >
                        <option value="">{chats.length ? 'Select a chat…' : 'No chats yet'}</option>
                        {chats.map((c) => (
                            <option key={c.chatId} value={c.chatId}>
                                {`${c.deployed ? '● ' : '○ '}${chatLabel(c)}`}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={loadChats}
                        title="Refresh chats"
                        aria-label="Refresh chats"
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                            strokeLinejoin="round" aria-hidden="true">
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                    </button>
                </div>
                {chatId && (
                    <span
                        className={`badge ${deployed ? 'badge-deployed' : 'badge-preview'}`}
                        title={deployed
                            ? 'Live — these resources are deployed in AWS'
                            : 'Design — a sketch; nothing is deployed to AWS yet'}
                        aria-label={`Diagram mode: ${deployed ? 'Live, deployed to AWS' : 'Design, not deployed'}`}
                    >
                        {deployed ? 'Live' : 'Design'}
                    </span>
                )}
                {chatId && (
                    <button
                        type="button"
                        className="details-btn"
                        onClick={() => setShowDetails((v) => !v)}
                        aria-expanded={showDetails}
                    >
                        Details
                    </button>
                )}
                <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`} role="status">
                    {connected ? 'live' : 'reconnecting…'}
                </span>
                <button className="guide-btn" onClick={openGuide} aria-expanded={showGuide}>
                    📘 Guide
                </button>
                <button className="settings-btn" onClick={openSettings} aria-expanded={showSettings}>
                    ⚙ Connect agent
                </button>
            </div>

            {showGuide && <McpGuide onOpenConnect={openSettings} />}

            {chatId && showDetails && selectedChat && (
                <div className="chat-details" role="region" aria-label="Chat details">
                    <div className="chat-details-row">
                        <label htmlFor={editingName ? 'chat-name' : undefined}>Name</label>
                        {editingName ? (
                            <span className="chat-details-edit">
                                <input
                                    id="chat-name"
                                    type="text"
                                    autoFocus
                                    placeholder="Session name"
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') renameChat();
                                        if (e.key === 'Escape') cancelRename();
                                    }}
                                />
                                <button type="button" className="details-save-btn" onClick={renameChat}>Save</button>
                                <button type="button" className="link-btn" onClick={cancelRename}>Cancel</button>
                            </span>
                        ) : (
                            <span className="chat-details-value chat-details-inline">
                                <span className="chat-details-name-text">
                                    {selectedChat.name || 'Untitled'}
                                </span>
                                <button type="button" className="link-btn" onClick={startRename}>Rename</button>
                            </span>
                        )}
                    </div>
                    <div className="chat-details-row">
                        <label>Mode</label>
                        <span className="chat-details-value chat-details-inline">
                            <span className={`badge ${deployed ? 'badge-deployed' : 'badge-preview'}`}>
                                {deployed ? 'Live' : 'Design'}
                            </span>
                            <span className="chat-details-mode-hint">
                                {deployed ? 'Deployed to AWS' : 'Not deployed — a design sketch'}
                            </span>
                        </span>
                    </div>
                    <div className="chat-details-row">
                        <label>Created</label>
                        <span className="chat-details-value">{formatDate(selectedChat.createdAt)}</span>
                    </div>
                    <div className="chat-details-row">
                        <label>Last update</label>
                        <span className="chat-details-value">{formatDate(selectedChat.updatedAt)}</span>
                    </div>
                    <div className="chat-details-row">
                        <label>Chat ID</label>
                        <span className="chat-details-value chat-details-inline">
                            <span className="chat-details-id-text">{selectedChat.chatId}</span>
                            <button
                                type="button"
                                className={`link-btn ${copied === 'cid' ? 'is-copied' : ''}`}
                                onClick={() => copy(selectedChat.chatId, 'cid')}
                            >
                                {copied === 'cid' ? 'Copied' : 'Copy'}
                            </button>
                        </span>
                    </div>
                </div>
            )}

            {showSettings && (
                <div className="viz-settings" role="region" aria-label="Connect your agent">
                    <div className="viz-settings-head">
                        <h3>Connect your agent</h3>
                        <p className="viz-settings-sub">
                            Register the <code>diagram-state-visualizer</code> MCP in your agent, then ask your
                            agent to deploy — after each change it reports what it created or removed and a live
                            diagram appears here. Each chat gets its own diagram. No AWS MCP needed; your agent
                            deploys with its own tools and just reports the result.
                        </p>
                    </div>

                    <ol className="viz-steps">
                        <li className="viz-step">
                            <div className="viz-step-num">1</div>
                            <div className="viz-step-body">
                                <div className="viz-step-title">
                                    {dev ? 'Local dev token' : 'Your API tokens'}
                                    {!dev && <span className="token-count">{tokens.length}/{TOKEN_LIMIT}</span>}
                                </div>

                                {dev ? (
                                    <>
                                        <p className="viz-step-hint">
                                            In local dev there's no login and no token generation: the MCP authenticates
                                            with this fixed token, set via the <code>DEV_VISUALIZER_TOKEN</code> env var.
                                            It resolves to your local dev profile (data is wiped when the server stops).
                                        </p>
                                        <div className="token-chip">
                                            <code>{devToken}</code>
                                            <button
                                                type="button"
                                                className={`copy-btn ${copied === 'devtok' ? 'is-copied' : ''}`}
                                                onClick={() => copy(devToken, 'devtok')}
                                            >
                                                {copied === 'devtok' ? 'Copied' : 'Copy'}
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                <>
                                <p className="viz-step-hint">
                                    A token authenticates your agent's pushes. Each token is shown in full only
                                    once, right after you generate it — copy it then. You can hold up to{' '}
                                    {TOKEN_LIMIT} tokens.
                                </p>

                                {tokens.length > 0 && (
                                    <ul className="token-list">
                                        {tokens.map((t) => (
                                            <li key={t.id} className="token-row">
                                                <code className="token-row-preview">{t.tokenPreview}</code>
                                                <span className="token-row-date">{formatDate(t.createdAt)}</span>
                                                {confirmRevoke === t.id ? (
                                                    <span className="token-row-confirm">
                                                        <span>Revoke?</span>
                                                        <button type="button" className="link-btn token-danger" onClick={() => revokeToken(t.id)}>Revoke</button>
                                                        <button type="button" className="link-btn" onClick={() => setConfirmRevoke('')}>Cancel</button>
                                                    </span>
                                                ) : (
                                                    <button type="button" className="link-btn" onClick={() => setConfirmRevoke(t.id)}>Revoke</button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <button
                                    className="viz-primary-btn"
                                    onClick={generateToken}
                                    disabled={tokens.length >= TOKEN_LIMIT}
                                >
                                    {tokens.length === 0 ? 'Generate token' : 'Generate another'}
                                </button>
                                {tokens.length >= TOKEN_LIMIT && (
                                    <p className="token-hint">Limit reached ({TOKEN_LIMIT}). Revoke one to add a new token.</p>
                                )}
                                {tokenError && <p className="token-hint token-danger">{tokenError}</p>}

                                {newToken && (
                                    <div className="token-new">
                                        <div className="token-new-title">New token — copy it now. It won't be shown again.</div>
                                        <div className="token-chip">
                                            <code>{newToken}</code>
                                            <button
                                                type="button"
                                                className={`copy-btn ${copied === 'tok' ? 'is-copied' : ''}`}
                                                onClick={() => copy(newToken, 'tok')}
                                            >
                                                {copied === 'tok' ? 'Copied' : 'Copy'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                                </>
                                )}
                            </div>
                        </li>

                        <li className="viz-step">
                            <div className="viz-step-num">2</div>
                            <div className="viz-step-body">
                                <div className="viz-step-title viz-step-title-row">
                                    <span>Add the MCP to your agent</span>
                                    {!dev && (
                                        <select
                                            className="agent-select"
                                            value={agent}
                                            onChange={(e) => setAgent(e.target.value)}
                                            aria-label="Choose your agent"
                                        >
                                            <option value="opencode">opencode</option>
                                            <option value="claude">Claude Code</option>
                                        </select>
                                    )}
                                </div>
                                {dev ? (
                                    <>
                                        <p className="viz-step-hint">
                                            Two ready-to-paste configs for a separate <code>-local</code> MCP pointing at
                                            your local backend (<code>{visualizerUrl}</code>), so it coexists with your
                                            hosted one. The fixed dev token <code>{devToken}</code> is already included.
                                        </p>
                                        <div className="cmd-label">Claude Code</div>
                                        <div className="cmd-block">
                                            <button
                                                type="button"
                                                className={`copy-btn ${copied === 'add-claude' ? 'is-copied' : ''}`}
                                                onClick={() => copy(claudeAddCommand, 'add-claude')}
                                            >
                                                {copied === 'add-claude' ? 'Copied' : 'Copy'}
                                            </button>
                                            <pre className="mcp-snippet">{claudeAddCommand}</pre>
                                        </div>
                                        <div className="cmd-label">
                                            opencode <span className="cmd-label-sub">— add under <code>mcp</code> in <code>~/.config/opencode/opencode.json</code></span>
                                        </div>
                                        <div className="cmd-block">
                                            <button
                                                type="button"
                                                className={`copy-btn ${copied === 'add-oc' ? 'is-copied' : ''}`}
                                                onClick={() => copy(opencodeDevSnippet, 'add-oc')}
                                            >
                                                {copied === 'add-oc' ? 'Copied' : 'Copy'}
                                            </button>
                                            <pre className="mcp-snippet">{opencodeDevSnippet}</pre>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        {agent === 'opencode' ? (
                                            newToken ? (
                                                <p className="viz-step-hint">
                                                    Paste this in your terminal — it installs opencode if needed and writes the
                                                    MCP into <code>~/.config/opencode/opencode.json</code> for you.{' '}
                                                    <strong>Your new token is already included.</strong> Re-running it later only
                                                    refreshes the token.
                                                </p>
                                            ) : (
                                                <p className="viz-step-hint">
                                                    Paste this in your terminal — it installs opencode if needed and writes the
                                                    MCP config for you. Replace <code>{TOKEN_PLACEHOLDER}</code> with your token
                                                    (shown once when generated; if you don't have it,{' '}
                                                    <strong>generate another above</strong>, up to {TOKEN_LIMIT}).
                                                </p>
                                            )
                                        ) : (
                                            newToken ? (
                                                <p className="viz-step-hint">
                                                    Paste the whole command in your terminal. User scope = loaded in every
                                                    session on this machine. <strong>Your new token is already included</strong>{' '}
                                                    in the command below.
                                                </p>
                                            ) : (
                                                <p className="viz-step-hint">
                                                    Paste the command in your terminal (user scope = loaded in every session on
                                                    this machine). Replace <code>{TOKEN_PLACEHOLDER}</code> with your token —
                                                    it's only shown once when generated, so if you don't have it,{' '}
                                                    <strong>generate another above</strong> (up to {TOKEN_LIMIT}).
                                                </p>
                                            )
                                        )}
                                        <div className="cmd-block">
                                            <button
                                                type="button"
                                                className={`copy-btn ${copied === 'add' ? 'is-copied' : ''}`}
                                                onClick={() => copy(addCommand, 'add')}
                                            >
                                                {copied === 'add' ? 'Copied' : 'Copy'}
                                            </button>
                                            <pre className="mcp-snippet">{addCommand}</pre>
                                        </div>
                                    </>
                                )}
                            </div>
                        </li>

                        <li className="viz-step">
                            <div className="viz-step-num">3</div>
                            <div className="viz-step-body">
                                <div className="viz-step-title">Deploy &amp; visualize</div>
                                <p className="viz-step-hint">
                                    Ask your agent to deploy — after each change it calls{' '}
                                    <code>push_deployment</code> with just what changed and the diagram updates
                                    here. To resume an earlier diagram, your agent runs <code>list_chats</code> and
                                    then <code>load_chat</code> with the closest diagram name (matched by
                                    proximity); or pin one via the <code>VISUALIZER_CHAT_ID</code> env var.
                                </p>
                            </div>
                        </li>
                    </ol>

                    <details className="viz-remove">
                        <summary>Remove the MCP later</summary>
                        {dev ? (
                            <>
                                <div className="cmd-block">
                                    <button
                                        type="button"
                                        className={`copy-btn ${copied === 'rm' ? 'is-copied' : ''}`}
                                        onClick={() => copy(claudeRemoveCommand, 'rm')}
                                    >
                                        {copied === 'rm' ? 'Copied' : 'Copy'}
                                    </button>
                                    <pre className="mcp-snippet">{claudeRemoveCommand}</pre>
                                </div>
                                <p className="viz-step-hint">
                                    For opencode, delete the <code>diagram-state-visualizer-local</code> entry under{' '}
                                    <code>mcp</code> in <code>~/.config/opencode/opencode.json</code>.
                                </p>
                            </>
                        ) : agent === 'opencode' ? (
                            <p className="viz-step-hint">
                                Delete the <code>diagram-state-visualizer</code>{' '}
                                entry under <code>mcp</code> in <code>~/.config/opencode/opencode.json</code>.
                            </p>
                        ) : (
                            <div className="cmd-block">
                                <button
                                    type="button"
                                    className={`copy-btn ${copied === 'rm' ? 'is-copied' : ''}`}
                                    onClick={() => copy(claudeRemoveCommand, 'rm')}
                                >
                                    {copied === 'rm' ? 'Copied' : 'Copy'}
                                </button>
                                <pre className="mcp-snippet">{claudeRemoveCommand}</pre>
                            </div>
                        )}
                    </details>
                </div>
            )}

            <section className="diagram-section" aria-label="Deployed architecture diagram">
                {svg ? (
                    <>
                        <Diagram
                            svg={svg}
                            renderError={renderError}
                            resources={resources}
                            selectedId={selectedResource?.id}
                            onSelectResource={setSelectedResource}
                        />
                        {selectedResource && (
                            <ResourceDetail
                                resource={selectedResource}
                                onClose={() => setSelectedResource(null)}
                            />
                        )}
                    </>
                ) : (
                    <div className="diagram-empty">
                        {chatId ? (
                            <>No deployed state yet for this chat. Deploy with your agent (it calls{' '}
                            <code>push_deployment</code>) to see the live diagram here.</>
                        ) : (
                            <div className="diagram-empty-hint">
                                <span className="diagram-empty-icon" aria-hidden="true">◇</span>
                                <span className="diagram-empty-title">Select a chat to view its diagram</span>
                                <span>
                                    {chats.length
                                        ? 'Pick a deployment from the Chat menu above.'
                                        : 'Connect your agent and ask it to deploy — a chat will appear here.'}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </section>
        </div>
    );
}
