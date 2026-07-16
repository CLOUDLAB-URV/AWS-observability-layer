import { useEffect, useRef, useState } from 'react';

// Short relative time ("2m ago", "3d ago") for the selector rows; falls back to a date for
// anything older than a week so rows stay compact.
function relativeTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(t).toLocaleDateString();
}

// The centred sigil picker: a large combobox button showing the selected sigil (status dot +
// name + last update) that opens a listbox of all the user's sigils, each with its
// Design/Live badge and last-updated time. Replaces the old small native <select>.
export default function SigilSelect({ chats, chatId, onSelect, onRefresh, chatLabel }) {
    const [open, setOpen] = useState(false);
    const [highlighted, setHighlighted] = useState(-1);
    const wrapRef = useRef(null);
    const listRef = useRef(null);

    const selected = chats.find((c) => c.chatId === chatId) || null;

    // Close on click-away / focus-away (same pattern as UserMenu).
    useEffect(() => {
        if (!open) return undefined;
        function onDocPointer(e) {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        }
        document.addEventListener('mousedown', onDocPointer);
        return () => document.removeEventListener('mousedown', onDocPointer);
    }, [open]);

    // Opening: refresh the list and highlight the current selection.
    function toggleOpen() {
        setOpen((was) => {
            if (!was) {
                onRefresh?.();
                setHighlighted(chats.findIndex((c) => c.chatId === chatId));
            }
            return !was;
        });
    }

    function choose(id) {
        onSelect(id);
        setOpen(false);
    }

    function onKeyDown(e) {
        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggleOpen();
            return;
        }
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlighted((i) => Math.min(chats.length - 1, i + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlighted((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlighted >= 0 && chats[highlighted]) choose(chats[highlighted].chatId);
        }
    }

    // Keep the highlighted row in view while arrowing through a long list.
    useEffect(() => {
        if (!open || highlighted < 0) return;
        listRef.current
            ?.querySelector(`[data-index="${highlighted}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [open, highlighted]);

    return (
        <div className="sigil-select" ref={wrapRef} onKeyDown={onKeyDown}>
            <button
                type="button"
                className={`sigil-select-trigger ${open ? 'is-open' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={selected
                    ? `Sigil: ${chatLabel(selected)} (${selected.deployed ? 'Live' : 'Design'})`
                    : 'Select a sigil'}
                onClick={toggleOpen}
            >
                {selected ? (
                    <>
                        <span
                            className={`sigil-dot ${selected.deployed ? 'sigil-dot-live' : 'sigil-dot-design'}`}
                            aria-hidden="true"
                        />
                        <span className="sigil-select-name">{chatLabel(selected)}</span>
                        <span className={`sigil-mode-badge ${selected.deployed ? 'is-live' : 'is-design'}`}>
                            {selected.deployed ? 'Live' : 'Design'}
                        </span>
                    </>
                ) : (
                    <span className="sigil-select-placeholder">
                        {chats.length ? 'Select a sigil…' : 'No sigils yet'}
                    </span>
                )}
                <svg className="sigil-select-caret" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>
            {open && (
                <div className="sigil-select-pop">
                    <div className="sigil-select-head">
                        <span className="sigil-select-count">
                            {chats.length === 1 ? '1 sigil' : `${chats.length} sigils`}
                        </span>
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={onRefresh}
                            title="Refresh sigils"
                            aria-label="Refresh sigils"
                        >
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                                strokeLinejoin="round" aria-hidden="true">
                                <polyline points="23 4 23 10 17 10" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                        </button>
                    </div>
                    {chats.length === 0 ? (
                        <div className="sigil-select-empty">
                            No sigils yet — connect your agent and push a deployment to create one.
                        </div>
                    ) : (
                        <ul className="sigil-select-list" role="listbox" aria-label="Sigils" ref={listRef}>
                            {chats.map((c, i) => (
                                <li key={c.chatId} role="presentation">
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={c.chatId === chatId}
                                        data-index={i}
                                        className={`sigil-option ${c.chatId === chatId ? 'is-selected' : ''} ${i === highlighted ? 'is-highlighted' : ''}`}
                                        onMouseEnter={() => setHighlighted(i)}
                                        onClick={() => choose(c.chatId)}
                                    >
                                        <span
                                            className={`sigil-dot ${c.deployed ? 'sigil-dot-live' : 'sigil-dot-design'}`}
                                            aria-hidden="true"
                                        />
                                        <span className="sigil-option-name">{chatLabel(c)}</span>
                                        <span className={`sigil-mode-badge ${c.deployed ? 'is-live' : 'is-design'}`}>
                                            {c.deployed ? 'Live' : 'Design'}
                                        </span>
                                        <span className="sigil-option-time">{relativeTime(c.updatedAt)}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
