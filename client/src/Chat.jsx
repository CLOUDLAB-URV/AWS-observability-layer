import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './markdown.jsx';

const MAX_INPUT_HEIGHT = 160;

export default function Chat({ messages, busy, onSend, chatPanel }) {
    const [draft, setDraft] = useState('');
    const [userScrolled, setUserScrolled] = useState(false);
    const logRef = useRef(null);
    const inputRef = useRef(null);
    const scrolledRef = useRef(false);

    const {
        collapsed, floating, maximized,
        floatPos, floatSize, chatRef,
        toggleCollapse, toggleFloat, toggleMaximize,
        startResize, startFloatDrag,
    } = chatPanel;

    // Auto-scroll only when user is at the bottom
    useEffect(() => {
        if (!scrolledRef.current) {
            logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
        }
    }, [messages]);

    const onScroll = () => {
        const el = logRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        scrolledRef.current = !atBottom;
        setUserScrolled(!atBottom);
    };

    const scrollToBottom = () => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
        scrolledRef.current = false;
        setUserScrolled(false);
    };

    const autosize = () => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    };
    useEffect(autosize, [draft]);

    const submit = (event) => {
        event?.preventDefault();
        const text = draft.trim();
        if (!text || busy) return;
        onSend(text);
        setDraft('');
    };

    const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    };

    // CSS custom properties for float position/size (applied inline, read by CSS)
    const floatStyle = floating
        ? {
              '--chat-float-x': `${floatPos.x}px`,
              '--chat-float-y': `${floatPos.y}px`,
              '--chat-float-w': `${floatSize.w}px`,
              '--chat-float-h': `${floatSize.h}px`,
          }
        : {};

    return (
        <aside
            ref={chatRef}
            className="chat"
            aria-label="Architecture chat panel"
            aria-hidden={collapsed ? 'true' : undefined}
            data-floating={floating ? 'true' : undefined}
            data-maximized={maximized ? 'true' : undefined}
            style={floatStyle}
        >
            {/* Resize handle (sidebar mode only) */}
            {!floating && !maximized && (
                <div
                    className="chat-resize-handle"
                    onMouseDown={startResize}
                    role="separator"
                    aria-label="Drag to resize chat panel"
                    aria-orientation="vertical"
                    tabIndex={0}
                />
            )}

            {/* Header */}
            <div
                className="chat-header"
                onMouseDown={floating ? startFloatDrag : undefined}
                style={floating ? { cursor: 'move', userSelect: 'none' } : undefined}
            >
                <h2 className="chat-title">Chat</h2>
                <button
                    className="chat-panel-btn"
                    onClick={toggleMaximize}
                    aria-label={maximized ? 'Exit maximize' : 'Maximize chat panel'}
                    aria-pressed={maximized}
                    title={maximized ? 'Exit maximize' : 'Maximize'}
                >
                    {maximized ? '⊡' : '⊞'}
                </button>
                <button
                    className="chat-panel-btn"
                    onClick={toggleFloat}
                    aria-label={floating ? 'Dock chat panel' : 'Float chat panel'}
                    aria-pressed={floating}
                    title={floating ? 'Dock' : 'Float'}
                >
                    {floating ? '⊟' : '◱'}
                </button>
                <button
                    className="chat-panel-btn"
                    onClick={toggleCollapse}
                    aria-label="Collapse chat panel"
                    aria-expanded="true"
                    title="Collapse"
                >
                    ✕
                </button>
            </div>

            {/* Message log */}
            <div
                id="chat-log"
                className="chat-log"
                ref={logRef}
                role="log"
                aria-label="Chat messages"
                aria-live="polite"
                aria-relevant="additions text"
                onScroll={onScroll}
            >
                {messages.map((message, index) => {
                    if (message.role === 'log') {
                        return (
                            <article
                                key={index}
                                className={`chat-message chat-log-entry${message.ok ? '' : ' log-entry-error'}`}
                                aria-label="Deploy log entry"
                            >
                                <span className={message.ok ? 'log-ok' : 'log-error'}>
                                    {message.ok ? '✓' : '✗'}{' '}
                                    <code>{message.text}</code>
                                    {message.error ? <em> — {message.error}</em> : null}
                                </span>
                            </article>
                        );
                    }

                    if (message.role === 'error') {
                        return (
                            <article
                                key={index}
                                className="chat-message chat-error"
                                role="alert"
                                aria-label="Error"
                            >
                                <span className="chat-error-icon" aria-hidden="true">⚠</span>
                                {message.text}
                            </article>
                        );
                    }

                    return (
                        <div key={index} className={`chat-message-row row-${message.role}`}>
                            {message.role === 'assistant' && (
                                <span className="chat-avatar" aria-hidden="true">⚡</span>
                            )}
                            <article
                                className={`chat-message chat-${message.role}`}
                                aria-label={message.role === 'user' ? 'You' : 'Assistant'}
                            >
                                {message.role === 'assistant'
                                    ? renderMarkdown(message.text)
                                    : message.text}
                            </article>
                        </div>
                    );
                })}

                {busy && (
                    <div className="chat-busy-wrapper" role="status" aria-label="Assistant is thinking">
                        <span className="chat-avatar" aria-hidden="true">⚡</span>
                        <div className="chat-busy-dots" aria-hidden="true">
                            <span /><span /><span />
                        </div>
                    </div>
                )}
            </div>

            {/* Scroll to bottom */}
            {userScrolled && (
                <button
                    className="chat-scroll-btn"
                    onClick={scrollToBottom}
                    aria-label="Scroll to latest message"
                >
                    ↓ Latest
                </button>
            )}

            {/* Input */}
            <div className="chat-input-area">
                <form className="chat-input" onSubmit={submit} aria-label="Send message">
                    <span id="chat-hint" className="sr-only">
                        Press Enter to send, Shift+Enter for new line
                    </span>
                    <label htmlFor="chat-textarea" className="sr-only">
                        Architecture description
                    </label>
                    <textarea
                        id="chat-textarea"
                        ref={inputRef}
                        rows={1}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={busy ? 'Working…' : 'Describe your AWS architecture…'}
                        disabled={busy}
                        aria-label="Describe your AWS architecture"
                        aria-describedby="chat-hint"
                        aria-multiline="true"
                    />
                    <button
                        type="submit"
                        disabled={busy || !draft.trim()}
                        aria-label="Send message"
                    >
                        Send
                    </button>
                </form>
                <p className="chat-hint" aria-hidden="true">
                    Enter to send · Shift+Enter for newline
                </p>
            </div>
        </aside>
    );
}
