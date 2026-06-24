import { useEffect, useRef, useState } from 'react';
import Chat from './Chat.jsx';
import Diagram from './Diagram.jsx';
import DeployedState from './DeployedState.jsx';
import ConfirmModal from './ConfirmModal.jsx';
import { createSocket } from './ws.js';
import { useDarkMode } from './hooks/useDarkMode.js';
import { useChatPanel } from './hooks/useChatPanel.js';

const MODE_LABELS = { preview: 'Preview', deployed: 'Deployed', partial: 'Partial' };

export default function App() {
    const [view, setView] = useState('design');
    const [connected, setConnected] = useState(false);
    const [mode, setMode] = useState('preview');
    const [svg, setSvg] = useState('');
    const [renderError, setRenderError] = useState(null);
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [projects, setProjects] = useState([]);
    const [currentProject, setCurrentProject] = useState('');
    const socketRef = useRef(null);

    const [isDark, toggleDark] = useDarkMode();
    const chatPanel = useChatPanel();
    const [confirmModal, setConfirmModal] = useState(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected);
        socketRef.current = socket;
        loadProjects();
        return () => socket.close();
    }, []);

    async function loadProjects() {
        try {
            const res = await fetch('/api/projects');
            const data = await res.json();
            setProjects(data.projects || []);
            if (data.current) setCurrentProject(data.current);
        } catch {
            setProjects([]);
        }
    }

    function selectProject(projectId) {
        if (busy || !projectId || projectId === currentProject) return;
        setCurrentProject(projectId);
        setMessages([]);
        setStatus('');
        socketRef.current?.send({ type: 'select-project', projectId });
    }

    async function createProject() {
        const name = window.prompt('New project name:');
        if (!name || !name.trim()) return;
        try {
            const res = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: name.trim() })
            });
            const data = await res.json();
            if (data.id) {
                await loadProjects();
                selectProject(data.id);
            }
        } catch {
            // ignore — the selector simply won't update
        }
    }

    function appendAssistantDelta(text) {
        setMessages((current) => {
            const last = current[current.length - 1];
            if (last && last.role === 'assistant' && last.streaming) {
                const updated = [...current];
                updated[updated.length - 1] = { ...last, text: last.text + text };
                return updated;
            }
            return [...current, { role: 'assistant', text, streaming: true }];
        });
    }

    function handleMessage(message) {
        switch (message.type) {
            case 'init':
                setMode(message.mode);
                setSvg(message.svg || '');
                setRenderError(message.renderError || null);
                if (message.project) setCurrentProject(message.project);
                break;
            case 'chat-delta':
                appendAssistantDelta(message.text);
                break;
            case 'chat-done':
                setBusy(false);
                setMessages((current) =>
                    current.map((entry) => (entry.streaming ? { ...entry, streaming: false } : entry))
                );
                break;
            case 'render-svg':
                setSvg(message.svg);
                setRenderError(null);
                break;
            case 'render-error':
                // Keep the last good svg visible; Diagram shows this as a
                // non-destructive overlay instead of blanking the canvas.
                setRenderError(message.error);
                break;
            case 'mode':
                setMode(message.mode);
                break;
            case 'status':
                setStatus(message.text);
                break;
            case 'deploy-log':
                setMessages((current) => [
                    ...current,
                    {
                        role: 'log',
                        text: message.entry.summary || message.entry.tool,
                        ok: message.entry.ok,
                        error: message.entry.error,
                    },
                ]);
                break;
            case 'error':
                setBusy(false);
                setStatus('');
                setMessages((current) => [
                    ...current,
                    { role: 'error', text: message.message },
                ]);
                break;
            default:
                break;
        }
    }

    function sendChat(text) {
        setMessages((current) => [...current, { role: 'user', text }]);
        setBusy(true);
        setStatus('');
        socketRef.current?.send({ type: 'chat', text });
    }

    function deploy() {
        if (busy) return;
        const retry = mode === 'partial';
        setConfirmModal({
            title: retry ? 'Retry deploy' : 'Deploy to AWS',
            message: retry
                ? 'This will try again to create the resources that failed, and finish deploying the rest of the architecture. Continue?'
                : 'This will create real AWS resources in your AWS account. Continue?',
            confirmLabel: retry ? 'Retry deploy' : 'Deploy',
            confirmClass: 'deploy-btn',
            onConfirm: () => {
                setBusy(true);
                socketRef.current?.send({ type: 'deploy' });
            },
        });
    }

    function teardown() {
        if (busy) return;
        setConfirmModal({
            title: 'Tear down resources',
            message: 'This permanently deletes ALL AWS resources created from this diagram and returns to preview mode. This cannot be undone.',
            confirmLabel: 'Tear down',
            confirmClass: 'teardown-btn',
            onConfirm: () => {
                setBusy(true);
                setStatus('');
                socketRef.current?.send({ type: 'teardown' });
            },
        });
    }

    return (
        <div className="app">
            {confirmModal && (
                <ConfirmModal
                    title={confirmModal.title}
                    message={confirmModal.message}
                    confirmLabel={confirmModal.confirmLabel}
                    confirmClass={confirmModal.confirmClass}
                    onConfirm={() => { setConfirmModal(null); confirmModal.onConfirm(); }}
                    onCancel={() => setConfirmModal(null)}
                />
            )}
            <header className="topbar" role="banner">
                <h1>AWS Architect</h1>
                <nav className="view-tabs" role="tablist" aria-label="View">
                    <button
                        role="tab"
                        aria-selected={view === 'design'}
                        className={`view-tab ${view === 'design' ? 'view-tab-active' : ''}`}
                        onClick={() => setView('design')}
                        title="Design an AWS architecture by chat and deploy it from the web"
                    >
                        Design &amp; Deploy
                    </button>
                    <button
                        role="tab"
                        aria-selected={view === 'deployed'}
                        className={`view-tab ${view === 'deployed' ? 'view-tab-active' : ''}`}
                        onClick={() => setView('deployed')}
                        title="Live diagram of what your coding agent (Claude Code / opencode) deploys via the MCP server"
                    >
                        Agent (MCP)
                    </button>
                </nav>
                {view === 'design' && (
                    <div className="project-form topbar-projects">
                        <label htmlFor="design-project" className="sr-only">Project</label>
                        <select
                            id="design-project"
                            value={currentProject}
                            onChange={(e) => selectProject(e.target.value)}
                            disabled={busy}
                            aria-label="Active design project"
                        >
                            {projects.length === 0 && <option value="">Loading…</option>}
                            {projects.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                        <button type="button" onClick={createProject} disabled={busy} title="New project">
                            + New
                        </button>
                    </div>
                )}
                {view === 'design' && (
                    <span
                        className={`badge badge-${mode}`}
                        aria-label={`Mode: ${MODE_LABELS[mode] || 'Preview'}`}
                    >
                        {MODE_LABELS[mode] || 'Preview'}
                    </span>
                )}
                <output className="status-text" aria-live="polite" aria-atomic="true">
                    {status}
                </output>
                <span
                    className={`conn ${connected ? 'conn-on' : 'conn-off'}`}
                    role="status"
                    aria-live="polite"
                    aria-label={connected ? 'Connected to server' : 'Reconnecting to server'}
                >
                    {connected ? 'connected' : 'reconnecting…'}
                </span>
                <button
                    className="dark-toggle-btn"
                    onClick={toggleDark}
                    aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                    aria-pressed={isDark}
                    title={isDark ? 'Light mode' : 'Dark mode'}
                >
                    {isDark ? '☀️' : '🌙'}
                </button>
                {view === 'design' && (mode === 'preview' || mode === 'partial') && (
                    <button
                        className="deploy-btn"
                        onClick={deploy}
                        disabled={busy || !svg}
                        aria-busy={busy}
                        aria-label={mode === 'partial' ? 'Retry deploying to AWS' : 'Deploy architecture to AWS'}
                    >
                        {mode === 'partial' ? 'Retry deploy' : 'Deploy to AWS'}
                    </button>
                )}
                {view === 'design' && (mode === 'deployed' || mode === 'partial') && (
                    <button
                        className="teardown-btn"
                        onClick={teardown}
                        disabled={busy}
                        aria-busy={busy}
                        aria-label="Tear down all AWS resources"
                    >
                        Tear down
                    </button>
                )}
            </header>
            {view === 'deployed' ? (
                <main id="main-content" className="layout layout-deployed" role="main">
                    <DeployedState />
                </main>
            ) : (
                <main
                    id="main-content"
                    className="layout"
                    role="main"
                    ref={chatPanel.layoutRef}
                    data-chat-collapsed={chatPanel.collapsed ? 'true' : undefined}
                    data-chat-floating={chatPanel.floating ? 'true' : undefined}
                >
                    {chatPanel.collapsed && (
                        <button
                            className="chat-reopen-btn"
                            onClick={chatPanel.toggleCollapse}
                            aria-label="Open chat panel"
                            title="Open chat"
                        >
                            💬 Chat
                        </button>
                    )}
                    <Chat
                        messages={messages}
                        busy={busy}
                        onSend={sendChat}
                        chatPanel={chatPanel}
                    />
                    <section className="diagram-section" aria-label="Architecture diagram">
                        <Diagram svg={svg} renderError={renderError} />
                    </section>
                </main>
            )}
        </div>
    );
}
