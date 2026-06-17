import { useEffect, useRef, useState } from 'react';
import Diagram from './Diagram.jsx';
import { createSocket } from './ws.js';

// "Deployed state" view: subscribes to one project on the visualizer socket and
// renders a live diagram of what is actually deployed in AWS (pushed from the
// user's agent via the MCP tool). Also hosts the API-token + MCP-config panel.
export default function DeployedState() {
    const [connected, setConnected] = useState(false);
    const [project, setProject] = useState('demo');
    const [draftProject, setDraftProject] = useState('demo');
    const [svg, setSvg] = useState('');
    const [renderError, setRenderError] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [newToken, setNewToken] = useState('');
    const [tokens, setTokens] = useState([]);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected, '/ws-visualizer');
        socketRef.current = socket;
        return () => socket.close();
    }, []);

    // (Re)subscribe whenever the active project changes or we (re)connect.
    useEffect(() => {
        if (connected && project) {
            setSvg('');
            setRenderError(null);
            socketRef.current?.send({ type: 'subscribe', projectId: project });
        }
    }, [connected, project]);

    function handleMessage(message) {
        switch (message.type) {
            case 'init':
            case 'render-svg':
                setSvg(message.svg || '');
                setRenderError(message.renderError || null);
                break;
            case 'error':
                setRenderError(message.message);
                break;
            default:
                break;
        }
    }

    function applyProject(event) {
        event.preventDefault();
        const next = draftProject.trim();
        if (next) {
            setProject(next);
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

    const mcpSnippet = `{
  "mcpServers": {
    "aws-deployed-state-visualizer": {
      "command": "node",
      "args": ["/absolute/path/to/aws-architect-web/mcp-visualizer/index.js"],
      "env": {
        "VISUALIZER_TOKEN": "${newToken || 'viz_…your token…'}"
      }
    }
  }
}`;

    return (
        <div className="deployed-state">
            <div className="deployed-toolbar">
                <form className="project-form" onSubmit={applyProject}>
                    <label htmlFor="viz-project">Project</label>
                    <input
                        id="viz-project"
                        value={draftProject}
                        onChange={(e) => setDraftProject(e.target.value)}
                        placeholder="project name"
                    />
                    <button type="submit">View</button>
                </form>
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
                        Generate an API token and paste it into the <code>mcp-visualizer</code> server config in your
                        coding agent (no AWS MCP needed — it runs the AWS CLI itself). Then ask the agent to deploy
                        and visualize; it calls <code>deploy_and_visualize</code> and the diagram appears here.
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
                        No deployed state yet for <strong>{project}</strong>. Deploy with your agent and call{' '}
                        <code>push_deployment</code> to see the live diagram here.
                    </div>
                )}
            </section>
        </div>
    );
}
