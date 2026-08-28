import { useEffect, useRef, useState } from 'react';

// "Share sigil" pop-up: turn the selected sigil into a public link, copy it, or stop sharing.
//
// What the link does is worth stating plainly in the UI, because it is not obvious and it is not
// reversible in people's heads once they have sent it to someone: while the sigil is a Design the
// page tracks every push, and the moment it is deployed the public side is pinned to the design as
// it stood right then — nothing that comes back from AWS is ever published.
export default function ShareModal({ chatId, deployed, onClose }) {
    const [state, setState] = useState({ loading: true, shared: false, url: null, frozen: false });
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/share`);
                const data = await res.json();
                if (!cancelled) setState({ loading: false, shared: !!data.shared, url: data.url, frozen: !!data.frozen });
            } catch {
                if (!cancelled) setState({ loading: false, shared: false, url: null, frozen: false });
            }
        })();
        return () => { cancelled = true; };
    }, [chatId]);

    async function start() {
        setBusy(true);
        setError('');
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/share`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) {
                setError(data?.error || 'Could not create the link. Try again.');
            } else {
                setState({ loading: false, shared: true, url: data.url, frozen: !!data.frozen });
            }
        } catch {
            setError('Could not create the link. Try again.');
        }
        setBusy(false);
    }

    async function stop() {
        setBusy(true);
        setError('');
        try {
            await fetch(`/api/chats/${encodeURIComponent(chatId)}/share`, { method: 'DELETE' });
            setState({ loading: false, shared: false, url: null, frozen: false });
            setCopied(false);
        } catch {
            setError('Could not stop sharing. Try again.');
        }
        setBusy(false);
    }

    async function copy() {
        if (!state.url) return;
        try {
            await navigator.clipboard.writeText(state.url);
        } catch {
            // Clipboard access can be refused (permissions, insecure origin) — select the text so
            // the link is still one keystroke away instead of leaving a dead button.
            inputRef.current?.select();
            return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
    }

    return (
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sh-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal-box">
                <div className="ca-head">
                    <h2 className="modal-title" id="sh-title">
                        <svg className="so-title-icon" viewBox="0 0 24 24" width="17" height="17" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            aria-hidden="true">
                            <circle cx="18" cy="5" r="3" />
                            <circle cx="6" cy="12" r="3" />
                            <circle cx="18" cy="19" r="3" />
                            <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
                            <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
                        </svg>
                        Share sigil
                    </h2>
                    <button type="button" className="rd-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="share-body">
                    {state.loading ? (
                        <p className="share-note">Loading…</p>
                    ) : state.shared ? (
                        <>
                            <p className="share-note">
                                Anyone with this link can open the diagram, explore every resource and export
                                it — no account needed. They cannot use Ask.
                            </p>
                            <div className="share-link-row">
                                <input
                                    ref={inputRef}
                                    className="share-link"
                                    type="text"
                                    readOnly
                                    value={state.url || ''}
                                    onFocus={(e) => e.target.select()}
                                    aria-label="Public link"
                                />
                                <button type="button" className="btn btn-primary" onClick={copy}>
                                    {copied ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                            <p className="share-note share-note-dim">
                                {state.frozen
                                    ? 'This sigil has been deployed, so the link is pinned to the design as it '
                                      + 'stood just before. It no longer updates, and nothing that came back '
                                      + 'from AWS is published.'
                                    : 'The page follows this sigil while it stays a Design. If you deploy it, the '
                                      + 'link freezes on the design as it stands at that moment — real ARNs and '
                                      + 'ids never reach it.'}
                            </p>
                            <div className="share-actions">
                                <button type="button" className="btn btn-ghost btn-danger" onClick={stop} disabled={busy}>
                                    Stop sharing
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="share-note">
                                Create a public link to this sigil. Anyone with it can open the diagram,
                                explore the resources and export the picture, without signing in.
                            </p>
                            {deployed && (
                                <p className="share-note share-note-dim">
                                    This sigil is Live, so everything in it came back from AWS. Only a Design
                                    sigil can be shared.
                                </p>
                            )}
                            <div className="share-actions">
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={start}
                                    disabled={busy || deployed}
                                >
                                    Create link
                                </button>
                            </div>
                        </>
                    )}
                    {error && <p className="share-error" role="alert">{error}</p>}
                </div>
            </div>
        </div>
    );
}
