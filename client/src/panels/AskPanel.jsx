import { useEffect, useRef, useState } from 'react';
import { useDeployed } from '../DeployedContext.js';
import { renderMarkdown } from '../markdown.jsx';

// Diagram Q&A chat. Each question is answered against the sigil's CURRENT state (the
// backend re-reads it per question), so the context is always live. Strictly informative
// — the chat can't change anything. History is persisted server-side per sigil.
const SUGGESTIONS = [
    'Summarize the whole diagram',
    "What's deployed to AWS right now?",
    'How do these resources connect to each other?',
    'Is anything in this sigil inconsistent or risky?'
];

export default function AskPanel(props) {
    const { chatId } = useDeployed();
    // messages: { role: 'user'|'assistant', text, pending?, error? } — a pending
    // assistant bubble streams in place; on failure it becomes an error bubble.
    const [messages, setMessages] = useState([]);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const bodyRef = useRef(null);
    const inputRef = useRef(null);
    const busyRef = useRef(false); // sync guard — state updates lag double-submits

    // Load the persisted conversation whenever the selected sigil changes.
    useEffect(() => {
        setMessages([]);
        setConfirmClear(false);
        if (!chatId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/ask`);
                const data = await res.json();
                if (!cancelled && res.ok) {
                    setMessages(Array.isArray(data.messages) ? data.messages : []);
                }
            } catch {
                // start empty — the user can still ask
            }
        })();
        return () => { cancelled = true; };
    }, [chatId]);

    // Keep the newest message in view while the answer streams in.
    useEffect(() => {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    async function send(text) {
        const question = String(text ?? '').trim();
        if (!question || !chatId || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setDraft('');
        setMessages((cur) => [
            ...cur,
            { role: 'user', text: question },
            { role: 'assistant', text: '', pending: true }
        ]);
        const patchLast = (patch) => setMessages((cur) =>
            cur.map((m, i) => (i === cur.length - 1 ? { ...m, ...patch } : m)));
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/ask`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question })
            });
            if (!res.ok || !res.body) {
                let msg = 'The answer failed — please try again.';
                try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
                throw new Error(msg);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let answer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                answer += decoder.decode(value, { stream: true });
                patchLast({ text: answer });
            }
            answer = (answer + decoder.decode()).trim();
            if (!answer) throw new Error('The answer came back empty — please try again.');
            patchLast({ text: answer, pending: false });
        } catch (err) {
            patchLast({ text: '', pending: false, error: err?.message || 'The answer failed — please try again.' });
        } finally {
            busyRef.current = false;
            setBusy(false);
            inputRef.current?.focus();
        }
    }

    // Retry a failed question: drop the error bubble + its question and resend.
    function retry() {
        const question = [...messages].reverse().find((m) => m.role === 'user')?.text;
        setMessages((cur) => cur.slice(0, -2));
        if (question) send(question);
    }

    async function clearChat() {
        setConfirmClear(false);
        setMessages([]);
        try {
            await fetch(`/api/chats/${encodeURIComponent(chatId)}/ask`, { method: 'DELETE' });
        } catch {
            // ignore — worst case the old history reappears on reload
        }
    }

    function onKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send(draft);
        }
    }

    // Grow the textarea with its content (up to the CSS max-height).
    function autoGrow(el) {
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }

    const canClear = messages.length > 0 && !busy;

    return (
        <div className="dv-pane ask-panel">
            <div className="rd-header">
                <h2>Ask about this sigil</h2>
                <div className="ask-header-actions">
                    {canClear && (confirmClear ? (
                        <span className="ask-clear-confirm">
                            <span>Sure?</span>
                            <button type="button" className="link-btn" onClick={clearChat}>Clear</button>
                            <button type="button" className="link-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
                        </span>
                    ) : (
                        <button type="button" className="link-btn" onClick={() => setConfirmClear(true)}>
                            Clear
                        </button>
                    ))}
                    <button
                        type="button"
                        className="rd-close"
                        onClick={() => props.api.close()}
                        aria-label="Close chat"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>

            <div className="ask-body" ref={bodyRef}>
                {!chatId ? (
                    <div className="ask-empty"><p>Select a sigil to ask about it.</p></div>
                ) : messages.length === 0 ? (
                    <div className="ask-empty">
                        <p>
                            Ask anything about this diagram — its resources, connections and what is
                            deployed. Answers always reflect the diagram as it is right now.
                        </p>
                        <div className="ask-suggestions">
                            {SUGGESTIONS.map((q) => (
                                <button key={q} type="button" className="ask-chip" onClick={() => send(q)}>
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    messages.map((m, i) => (
                        m.role === 'user' ? (
                            <div key={i} className="ask-msg ask-msg-user">{m.text}</div>
                        ) : m.error ? (
                            <div key={i} className="ask-msg ask-msg-error">
                                <span>{m.error}</span>
                                {i === messages.length - 1 && !busy && (
                                    <button type="button" className="link-btn" onClick={retry}>Retry</button>
                                )}
                            </div>
                        ) : (
                            <div key={i} className="ask-msg ask-msg-assistant">
                                {m.pending && !m.text ? (
                                    <span className="ask-typing" aria-label="Thinking">
                                        <span /><span /><span />
                                    </span>
                                ) : (
                                    <div className="md-body">{renderMarkdown(m.text)}</div>
                                )}
                            </div>
                        )
                    ))
                )}
            </div>

            <div className="ask-inputbar">
                <textarea
                    ref={inputRef}
                    className="ask-input"
                    rows={1}
                    placeholder={chatId ? 'Ask about the diagram…' : 'Select a sigil first'}
                    value={draft}
                    disabled={!chatId || busy}
                    maxLength={2000}
                    onChange={(e) => { setDraft(e.target.value); autoGrow(e.target); }}
                    onKeyDown={onKeyDown}
                    aria-label="Ask about the diagram"
                />
                <button
                    type="button"
                    className="ask-send"
                    onClick={() => send(draft)}
                    disabled={!chatId || busy || !draft.trim()}
                    aria-label="Send question"
                    title="Send (Enter)"
                >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="22" y1="2" x2="11" y2="13" />
                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                </button>
            </div>
        </div>
    );
}
