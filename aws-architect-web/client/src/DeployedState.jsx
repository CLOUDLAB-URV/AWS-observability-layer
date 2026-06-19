import { useEffect, useRef, useState } from 'react';
import Diagram from './Diagram.jsx';
import { createSocket } from './ws.js';

// localStorage flag so the first-run "Connect agent" pop-up only auto-opens once.
const CONNECT_SEEN_KEY = 'viz.connectSeen';

// "Deployed state" view: subscribes to one chat on the visualizer socket and
// renders a live diagram of what is actually deployed in AWS (pushed from the
// user's agent via the MCP tool). Each chat has its own isolated diagram. Also
// hosts the API-token + MCP-config "Connect agent" modal, which auto-opens the
// first time a user enters this mode without a token yet.
export default function DeployedState() {
    const [connected, setConnected] = useState(false);
    const [chats, setChats] = useState([]);
    const [chatId, setChatId] = useState('');
    const [svg, setSvg] = useState('');
    const [renderError, setRenderError] = useState(null);
    const [showConnect, setShowConnect] = useState(false);
    const [newToken, setNewToken] = useState('');
    const [tokens, setTokens] = useState([]);
    const [copied, setCopied] = useState(false);
    const [renameValue, setRenameValue] = useState('');
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected, '/ws-visualizer');
        socketRef.current = socket;
        loadChats();
        // First run in MCP mode: if the user has no token yet, proactively open the
        // Connect-agent pop-up (once — guarded by a localStorage flag).
        loadTokens().then((list) => {
            if (list.length === 0 && !localStorage.getItem(CONNECT_SEEN_KEY)) {
                localStorage.setItem(CONNECT_SEEN_KEY, '1');
                setShowConnect(true);
            }
        });
        return () => socket.close();
    }, []);

    // (Re)subscribe whenever the active chat changes or we (re)connect.
    useEffect(() => {
        if (connected && chatId) {
            setSvg('');
            setRenderError(null);
            socketRef.current?.send({ type: 'subscribe', chatId });
        }
    }, [connected, chatId]);

    // Keep the rename field in sync with the selected chat's current name.
    useEffect(() => {
        const current = chats.find((c) => c.chatId === chatId);
        setRenameValue(current?.name || '');
    }, [chatId, chats]);

    // Close the Connect-agent modal on Escape while it's open.
    useEffect(() => {
        if (!showConnect) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') closeConnect(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showConnect]);

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
            // Default to the newest chat if none selected yet.
            setChatId((current) => current || (list[0] ? list[0].chatId : ''));
        } catch {
            setChats([]);
        }
    }

    // Loads the masked token list and returns it (so callers can react to it).
    async function loadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            const list = data.tokens || [];
            setTokens(list);
            return list;
        } catch {
            setTokens([]);
            return [];
        }
    }

    async function generateToken() {
        try {
            const res = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ label: 'web' })
            });
            const data = await res.json();
            setNewToken(data.token || '');
            setCopied(false);
            loadTokens();
        } catch {
            setNewToken('');
        }
    }

    async function copyToken() {
        if (!newToken) return;
        try {
            await navigator.clipboard.writeText(newToken);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable (e.g. non-secure context) — the token stays
            // visible for manual selection.
        }
    }

    function openConnect() {
        setShowConnect(true);
        loadTokens();
    }

    function closeConnect() {
        setShowConnect(false);
    }

    async function renameChat() {
        const name = renameValue.trim();
        if (!chatId || !name) return;
        try {
            await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name })
            });
            loadChats();
        } catch {
            // leave the field as-is; the user can retry
        }
    }

    function chatLabel(c) {
        const short = c.chatId.slice(0, 8);
        const when = c.updatedAt ? ` · ${new Date(c.updatedAt).toLocaleString()}` : '';
        return `${c.name || '(unnamed)'} · ${short}${when}`;
    }

    const mcpSnippet = `{
  "mcpServers": {
    "diagram-state-visualizer": {
      "command": "npx",
      "args": ["-y", "diagram-state-visualizer-mcp@latest"],
      "env": {
        "VISUALIZER_TOKEN": "${newToken || 'viz_…your token…'}"
      }
    }
  }
}`;

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
                        {chats.length === 0 && <option value="">No chats yet</option>}
                        {chats.map((c) => (
                            <option key={c.chatId} value={c.chatId}>
                                {chatLabel(c)}
                            </option>
                        ))}
                    </select>
                    <button type="button" onClick={loadChats}>Refresh</button>
                    {chatId && (
                        <span className="chat-rename">
                            <input
                                type="text"
                                aria-label="Session name"
                                placeholder="Session name"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && renameChat()}
                            />
                            <button type="button" onClick={renameChat}>Rename</button>
                        </span>
                    )}
                </div>
                <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`} role="status">
                    {connected ? 'live' : 'reconnecting…'}
                </span>
                <button className="settings-btn" onClick={openConnect} aria-haspopup="dialog">
                    ⚙ Connect agent
                </button>
            </div>

            {showConnect && (
                <div
                    className="modal-backdrop"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="connect-title"
                    onClick={(e) => { if (e.target === e.currentTarget) closeConnect(); }}
                >
                    <div className="modal-box connect-modal">
                        <h2 className="modal-title" id="connect-title">Connect your agent</h2>
                        <p>
                            Generate an API token and paste it into the <code>diagram-state-visualizer</code> MCP
                            server config in your coding agent (Claude Code / opencode — no AWS MCP needed, it runs
                            the AWS CLI itself). Each session gets its own isolated diagram and is named
                            automatically from its architecture (you can rename it here). Then ask the agent to
                            deploy and visualize; it calls <code>deploy_and_visualize</code> and the diagram appears
                            in this view.
                        </p>
                        <div className="connect-actions">
                            <button onClick={generateToken}>Generate token</button>
                        </div>
                        {newToken && (
                            <div className="token-value">
                                <strong>New token — copy it now (shown only once):</strong>
                                <div className="token-row">
                                    <code>{newToken}</code>
                                    <button type="button" className="token-copy-btn" onClick={copyToken}>
                                        {copied ? 'Copied ✓' : 'Copy'}
                                    </button>
                                </div>
                            </div>
                        )}
                        <pre className="mcp-snippet">{mcpSnippet}</pre>
                        {tokens.length > 0 && (
                            <ul className="token-list">
                                {tokens.map((t, i) => (
                                    <li key={i}>
                                        <code>{t.tokenPreview}</code> {t.label && `(${t.label})`}
                                        {t.createdAt && ` — ${new Date(t.createdAt).toLocaleString()}`}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="modal-actions">
                            <button className="modal-cancel-btn" onClick={closeConnect}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            <section className="diagram-section" aria-label="Deployed architecture diagram">
                {svg ? (
                    <Diagram svg={svg} renderError={renderError} />
                ) : (
                    <div className="diagram-empty">
                        {chatId ? (
                            <>No deployed state yet for this chat. Deploy with your agent (it calls{' '}
                            <code>deploy_and_visualize</code>) to see the live diagram here.</>
                        ) : (
                            <>No chats yet. Connect your agent and ask it to deploy and visualize — a chat will
                            appear here automatically.</>
                        )}
                    </div>
                )}
            </section>
        </div>
    );
}
