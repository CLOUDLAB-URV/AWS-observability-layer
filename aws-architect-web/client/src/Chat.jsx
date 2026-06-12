import { useEffect, useRef, useState } from 'react';

export default function Chat({ messages, busy, onSend }) {
    const [draft, setDraft] = useState('');
    const logRef = useRef(null);

    useEffect(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    }, [messages]);

    const submit = (event) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || busy) return;
        onSend(text);
        setDraft('');
    };

    return (
        <div className="chat">
            <div className="chat-log" ref={logRef}>
                {messages.map((message, index) => (
                    <div key={index} className={`chat-message chat-${message.role}`}>
                        {message.role === 'log' ? (
                            <span className={message.ok ? 'log-ok' : 'log-error'}>
                                {message.ok ? '✓' : '✗'} <code>{message.text}</code>
                                {message.error ? <em> — {message.error}</em> : null}
                            </span>
                        ) : (
                            message.text
                        )}
                    </div>
                ))}
                {busy && <div className="chat-message chat-busy">…</div>}
            </div>
            <form className="chat-input" onSubmit={submit}>
                <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={busy ? 'Working…' : 'Describe your AWS architecture…'}
                    disabled={busy}
                />
                <button type="submit" disabled={busy || !draft.trim()}>
                    Send
                </button>
            </form>
        </div>
    );
}
