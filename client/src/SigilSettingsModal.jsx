import { useEffect } from 'react';
import { useDeployed } from './DeployedContext.js';
import Segment from './Segment.jsx';

const ON_OFF = [['on', 'On'], ['off', 'Off']];

// One "Diagram display" row: a label, an On/Off segmented control, and a short hint underneath.
// Purely cosmetic — see Diagram.jsx's vizPrefs effect for how these apply to the canvas, and
// exportDiagram.js for how the same preference carries into downloaded files.
function DisplayRow({ title, hint, value, onChange }) {
    return (
        <div className="so-viz-row">
            <div className="ex-row">
                <span className="ca-field-label">{title}</span>
                <Segment
                    label={title}
                    options={ON_OFF}
                    value={value ? 'on' : 'off'}
                    onChange={(v) => onChange(v === 'on')}
                />
            </div>
            <p className="ca-hint">{hint}</p>
        </div>
    );
}

// "Sigil options" pop-up — the sigil's settings and data, shown as a modal (same shell as the
// Connect agent modal). Reads everything it needs from the DeployedContext (it's rendered
// inside the provider), so it reuses the existing rename/delete/copy logic with no new state.
// Layout separates what you can CHANGE (rename, delete) from the sigil's own read-only DATA.
export default function SigilSettingsModal({ onClose }) {
    const {
        selectedChat, deployed, mixed, divergentCount, resources,
        renameValue, setRenameValue, renameChat, renameError, setRenameError, formatDate,
        confirmDelete, setConfirmDelete, deleteChat, deleting,
        vizPrefs, setVizPref
    } = useDeployed();

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    if (!selectedChat) return null;

    const currentName = selectedChat.name || '';
    const trimmed = renameValue.trim();
    const canSave = trimmed.length > 0 && trimmed !== currentName;

    function save() {
        if (canSave) renameChat();
    }

    return (
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="so-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal-box modal-box-wide">
                <div className="ca-head">
                    <h2 className="modal-title" id="so-title">
                        <svg className="so-title-icon" viewBox="0 0 24 24" width="17" height="17" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            aria-hidden="true">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                        Sigil options
                    </h2>
                    <button type="button" className="rd-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="ca-body so-body">
                    {/* Editable — rename */}
                    <div className="ca-field-label">Name</div>
                    <div className="so-name">
                        <input
                            type="text"
                            className="ca-name-input"
                            placeholder="Sigil name"
                            value={renameValue}
                            onChange={(e) => { setRenameValue(e.target.value); if (renameError) setRenameError(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                            aria-label="Sigil name"
                            maxLength={80}
                            autoFocus
                        />
                        <button type="button" className="btn btn-primary" onClick={save} disabled={!canSave}>
                            Save
                        </button>
                    </div>
                    {renameError && <p className="so-name-error" role="alert">{renameError}</p>}

                    {/* Read-only — the sigil's own data */}
                    <div className="ca-field-label ca-field-label-spaced">Details</div>
                    <dl className="so-info">
                        <div className="so-info-row">
                            <dt>Mode</dt>
                            <dd className="so-info-inline">
                                <span className={`badge ${deployed ? 'badge-deployed' : 'badge-preview'}`}>
                                    {deployed ? 'Live' : 'Design'}
                                </span>
                                <span className="so-info-hint">
                                    {deployed ? 'Deployed to AWS' : 'A design sketch — not deployed'}
                                </span>
                            </dd>
                        </div>
                        {mixed && (
                            <div className="so-info-row">
                                <dt>Consistency</dt>
                                <dd className="so-info-inline so-mixed">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                        <line x1="12" y1="9" x2="12" y2="13" />
                                        <line x1="12" y1="17" x2="12.01" y2="17" />
                                    </svg>
                                    <span>
                                        {divergentCount} of {resources.length} resource{resources.length === 1 ? '' : 's'}{' '}
                                        {deployed ? 'not deployed to AWS yet' : 'already deployed to AWS'} — marked on the diagram.
                                    </span>
                                </dd>
                            </div>
                        )}
                        <div className="so-info-row">
                            <dt>Created</dt>
                            <dd>{formatDate(selectedChat.createdAt)}</dd>
                        </div>
                        <div className="so-info-row">
                            <dt>Last update</dt>
                            <dd>{formatDate(selectedChat.updatedAt)}</dd>
                        </div>
                    </dl>

                    {/* Cosmetic — how this sigil's diagram displays (frontend-only; never changes
                        what the agent generates, and carries into exports of this sigil too) */}
                    <div className="ca-field-label ca-field-label-spaced">Diagram display</div>
                    <div className="so-viz">
                        <DisplayRow
                            title="Connection labels"
                            hint="Protocol and port shown on each connection (e.g. &quot;HTTPS :443&quot;)."
                            value={vizPrefs.showConnectionLabels}
                            onChange={(v) => setVizPref('showConnectionLabels', v)}
                        />
                        <DisplayRow
                            title="Service names"
                            hint="The AWS service name shown under each icon (e.g. &quot;S3&quot;, &quot;DynamoDB&quot;)."
                            value={vizPrefs.showServiceLabels}
                            onChange={(v) => setVizPref('showServiceLabels', v)}
                        />
                        <DisplayRow
                            title="Group boxes"
                            hint="The colored category boxes around related services (Compute, Messaging, Data…)."
                            value={vizPrefs.showGroupBoxes}
                            onChange={(v) => setVizPref('showGroupBoxes', v)}
                        />
                        <DisplayRow
                            title="Animated flow"
                            hint="Dashed lines flow along each connection, in the direction of the arrow."
                            value={vizPrefs.animateArrows}
                            onChange={(v) => setVizPref('animateArrows', v)}
                        />
                    </div>

                    {/* Destructive — delete */}
                    <div className="so-danger">
                        <div className="so-danger-text">
                            <span className="so-danger-title">Delete this sigil</span>
                            <span className="so-danger-sub">Permanently removes the sigil and all its data. This can't be undone.</span>
                        </div>
                        {confirmDelete ? (
                            <span className="so-danger-confirm">
                                <span>Sure?</span>
                                <button type="button" className="btn btn-danger" onClick={deleteChat} disabled={deleting}>
                                    {deleting ? 'Deleting…' : 'Delete'}
                                </button>
                                <button type="button" className="link-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                            </span>
                        ) : (
                            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                                Delete sigil
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
