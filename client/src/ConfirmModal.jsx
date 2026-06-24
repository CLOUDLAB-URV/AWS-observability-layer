import { useEffect, useRef } from 'react';

export default function ConfirmModal({ title, message, confirmLabel, confirmClass, onConfirm, onCancel }) {
    const confirmRef = useRef(null);

    useEffect(() => {
        confirmRef.current?.focus();
        const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div className="modal-box">
                <h2 className="modal-title" id="modal-title">{title}</h2>
                <p className="modal-message">{message}</p>
                <div className="modal-actions">
                    <button className="modal-cancel-btn" onClick={onCancel}>Cancel</button>
                    <button ref={confirmRef} className={`modal-confirm-btn ${confirmClass || ''}`} onClick={onConfirm}>
                        {confirmLabel || 'Confirm'}
                    </button>
                </div>
            </div>
        </div>
    );
}
