import { useEffect } from 'react';
import McpGuide from './McpGuide.jsx';

// The Sigilum usage guide as a pop-up card (same shell as Connect agent / Sigil options). It used
// to be a dockable side panel, but it's read-once reference material — it has no business holding
// toolbar space or stealing width from the diagram. `onOpenConnect` hands off to the Connect agent
// modal so the token setup stays one click away from the instructions that mention it.
export default function GuideModal({ onClose, onOpenConnect }) {
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal-box modal-box-wide">
                <div className="ca-head">
                    <h2 className="modal-title" id="guide-title">
                        <svg className="so-title-icon" viewBox="0 0 24 24" width="17" height="17" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            aria-hidden="true">
                            <circle cx="12" cy="12" r="9" />
                            <polygon points="15.6 8.4 13.6 13.6 8.4 15.6 10.4 10.4 15.6 8.4" />
                        </svg>
                        Guide
                    </h2>
                    <button type="button" className="rd-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>

                <McpGuide onOpenConnect={onOpenConnect} inModal />
            </div>
        </div>
    );
}
