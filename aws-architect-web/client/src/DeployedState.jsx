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
    const [copied, setCopied] = useState('');
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected, '/ws-visualizer');
        socketRef.current = socket;
        loadChats();
        return () => socket.close();
    }, []);

    // (Re)subscribe whenever the active chat changes or we (re)connect. With no chat
    // selected we show nothing — the diagram only loads once the user picks a chat.
    useEffect(() => {
        setSvg('');
        setRenderError(null);
        if (connected && chatId) {
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
            // No auto-select: the diagram only appears once the user picks a chat.
        } catch {
            setChats([]);
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
        } catch {
            setNewToken('');
        }
    }

    function openSettings() {
        setShowSettings((v) => !v);
    }

    function chatLabel(c) {
        const short = c.chatId.slice(0, 8);
        const when = c.updatedAt ? ` · ${new Date(c.updatedAt).toLocaleString()}` : '';
        return `${c.project || '(no label)'} · ${short}${when}`;
    }

    // Unique-per-OS-user server name ($USER expands when pasted into a shell), so the
    // same command is safe to run on any machine without colliding with other configs.
    const SERVER_NAME = 'diagram-state-visualizer-$USER';
    // Use the freshly generated token if we have one; otherwise a placeholder the user
    // replaces. The full secret of an existing token is never returned to the UI, so a
    // ready-to-paste command is only possible right after generating it.
    const tokenForCmd = newToken || 'viz_your_token_here';
    // Ready-to-paste Claude Code CLI command: registers the published MCP at user scope
    // (loaded in every session on this machine) with the token baked in.
    const addCommand = `claude mcp add --scope user ${SERVER_NAME} \\
    --env VISUALIZER_TOKEN=${tokenForCmd} \\
    -- npx -y diagram-state-visualizer-mcp@latest`;
    const removeCommand = `claude mcp remove --scope user ${SERVER_NAME}`;

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
                    <div className="viz-settings-head">
                        <h3>Connect your agent</h3>
                        <p className="viz-settings-sub">
                            Register the <code>diagram-state-visualizer</code> MCP in Claude Code, then ask your
                            agent to deploy — after each change it reports what it created or removed and a live
                            diagram appears here. Each chat gets its own diagram. No AWS MCP needed; your agent
                            deploys with its own tools and just reports the result.
                        </p>
                    </div>

                    <ol className="viz-steps">
                        <li className="viz-step">
                            <div className="viz-step-num">1</div>
                            <div className="viz-step-body">
                                <div className="viz-step-title">Generate an API token</div>
                                <p className="viz-step-hint">
                                    It authenticates your agent's pushes. Copy it now — for security it's shown
                                    only once.
                                </p>
                                <button className="viz-primary-btn" onClick={generateToken}>
                                    {newToken ? 'Generate another' : 'Generate token'}
                                </button>
                                {newToken && (
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
                                )}
                            </div>
                        </li>

                        <li className="viz-step">
                            <div className="viz-step-num">2</div>
                            <div className="viz-step-body">
                                <div className="viz-step-title">Add the MCP to Claude Code</div>
                                <p className="viz-step-hint">
                                    Paste the whole command in your terminal. User scope = loaded in every session
                                    on this machine (works on any device with Claude Code installed). The token
                                    above is already baked in.
                                </p>
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
                            </div>
                        </li>

                        <li className="viz-step">
                            <div className="viz-step-num">3</div>
                            <div className="viz-step-body">
                                <div className="viz-step-title">Deploy &amp; visualize</div>
                                <p className="viz-step-hint">
                                    Ask your agent to deploy — after each change it calls{' '}
                                    <code>push_deployment</code> with just what changed and the diagram updates
                                    here. Resume an earlier one with <code>list_chats</code> →{' '}
                                    <code>load_chat</code>, or pin a chat via the <code>VISUALIZER_CHAT_ID</code> env
                                    var.
                                </p>
                            </div>
                        </li>
                    </ol>

                    <details className="viz-remove">
                        <summary>Remove the MCP later</summary>
                        <div className="cmd-block">
                            <button
                                type="button"
                                className={`copy-btn ${copied === 'rm' ? 'is-copied' : ''}`}
                                onClick={() => copy(removeCommand, 'rm')}
                            >
                                {copied === 'rm' ? 'Copied' : 'Copy'}
                            </button>
                            <pre className="mcp-snippet">{removeCommand}</pre>
                        </div>
                    </details>
                </div>
            )}

            <section className="diagram-section" aria-label="Deployed architecture diagram">
                {svg ? (
                    <Diagram svg={svg} renderError={renderError} />
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
