import { useEffect, useRef, useState } from 'react';
import Diagram from './Diagram.jsx';
import { createSocket } from './ws.js';

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
    const [newToken, setNewToken] = useState('');
    const [tokens, setTokens] = useState([]);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected, '/ws-visualizer');
        socketRef.current = socket;
        loadChats();
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

    async function loadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            setTokens(data.tokens || []);
        } catch {
            setTokens([]);
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
            loadTokens();
        } catch {
            setNewToken('');
        }
    }

    function openSettings() {
        setShowSettings((v) => !v);
        if (!showSettings) loadTokens();
    }

    function chatLabel(c) {
        const short = c.chatId.slice(0, 8);
        const when = c.updatedAt ? ` · ${new Date(c.updatedAt).toLocaleString()}` : '';
        return `${c.project || '(no label)'} · ${short}${when}`;
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
                </div>
                <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`} role="status">
                    {connected ? 'live' : 'reconnecting…'}
                </span>
                <button className="settings-btn" onClick={openSettings} aria-expanded={showSettings}>
                    ⚙ Connect agent
                </button>
            </div>

            {showSettings && (
                <div className="viz-settings" role="region" aria-label="Connect your agent">
                    <p>
                        Generate an API token and paste it into the <code>diagram-state-visualizer</code> MCP server
                        config in your coding agent (no AWS MCP needed — it runs the AWS CLI itself). Each chat
                        automatically gets its own isolated diagram, so you don't manage project names. Then ask the
                        agent to deploy and visualize; it calls <code>deploy_and_visualize</code> and the diagram
                        appears here. To resume an earlier deployment, ask it to <code>list_chats</code> then{' '}
                        <code>load_chat</code> (or pin a chat with the <code>VISUALIZER_CHAT_ID</code> env var).
                    </p>
                    <button onClick={generateToken}>Generate token</button>
                    {newToken && (
                        <p className="token-value">
                            <strong>New token (copy it now):</strong> <code>{newToken}</code>
                        </p>
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
