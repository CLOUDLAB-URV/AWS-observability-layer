import { useEffect, useRef, useState } from 'react';
import Chat from './Chat.jsx';
import Diagram from './Diagram.jsx';
import { createSocket } from './ws.js';

export default function App() {
    const [connected, setConnected] = useState(false);
    const [mode, setMode] = useState('preview');
    const [svg, setSvg] = useState('');
    const [renderError, setRenderError] = useState(null);
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected);
        socketRef.current = socket;
        return () => socket.close();
    }, []);

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
                        error: message.entry.error
                    }
                ]);
                break;
            case 'error':
                setBusy(false);
                setStatus('');
                setMessages((current) => [...current, { role: 'assistant', text: `⚠ ${message.message}` }]);
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
        if (!window.confirm('Deploy this architecture into AWS? Resources will be created in the cloudlab account.')) {
            return;
        }
        setBusy(true);
        socketRef.current?.send({ type: 'deploy' });
    }

    return (
        <div className="app">
            <header className="topbar">
                <h1>AWS Architect</h1>
                <span className={`badge badge-${mode}`}>{mode === 'preview' ? 'Preview' : 'Deployed'}</span>
                <span className="status-text">{status}</span>
                <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`}>
                    {connected ? 'connected' : 'reconnecting…'}
                </span>
                {mode === 'preview' && (
                    <button className="deploy-btn" onClick={deploy} disabled={busy || !svg}>
                        Deploy to AWS
                    </button>
                )}
            </header>
            <main className="layout">
                <Chat messages={messages} busy={busy} onSend={sendChat} />
                <Diagram svg={svg} renderError={renderError} />
            </main>
        </div>
    );
}
