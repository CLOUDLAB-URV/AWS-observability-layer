import { useDeployed } from './DeployedContext.js';
import Segment from './Segment.jsx';
import Slider from './Slider.jsx';

const ON_OFF = [['on', 'On'], ['off', 'Off']];
const LINE_STYLE_OPTIONS = [['normal', 'Normal'], ['dashed', 'Dashed']];

// Line thickness slider bounds (px) and animation-speed slider bounds (seconds per flow cycle).
// SPEED is inverted in the UI so dragging RIGHT = faster while the stored value stays a duration:
// the raw slider value is (SPEED_MIN + SPEED_MAX - seconds), so a bigger raw value → smaller
// duration → faster flow.
const THICK_MIN = 1, THICK_MAX = 6, THICK_STEP = 0.5;
const SPEED_MIN = 0.3, SPEED_MAX = 2.2, SPEED_STEP = 0.05;

// One "Diagram display" row: a title + short hint, and a control. The row is stacked (title on top,
// control below) by default and switches to a compact side-by-side layout in a wide panel — see the
// .so-row container query in styles.css. Shared shell for the On/Off, segmented and slider rows.
function Row({ title, hint, children }) {
    return (
        <div className="so-row">
            <div className="so-row-head">
                <span className="ca-field-label">{title}</span>
                <p className="ca-hint">{hint}</p>
            </div>
            <div className="so-row-control">{children}</div>
        </div>
    );
}

// "Sigil options" — the sigil's settings and data, rendered as a docked side panel (not a modal).
// Reads everything from the DeployedContext (it lives inside the provider), reusing the existing
// rename/delete logic and the per-sigil display preferences with no new state. Layout separates
// what you can CHANGE (rename, display, delete) from the sigil's own read-only DATA.
export default function SigilOptions({ onClose }) {
    const {
        selectedChat, deployed, mixed, divergentCount, resources,
        renameValue, setRenameValue, renameChat, renameError, setRenameError, formatDate,
        confirmDelete, setConfirmDelete, deleteChat, deleting,
        vizPrefs, setVizPref, hasSteps
    } = useDeployed();

    if (!selectedChat) return null;

    const currentName = selectedChat.name || '';
    const trimmed = renameValue.trim();
    const canSave = trimmed.length > 0 && trimmed !== currentName;

    function save() {
        if (canSave) renameChat();
    }

    // Line style is forced to Dashed while flow is animated (an animated solid line has no dashes to
    // move); the stored dashedLines is never overwritten, so turning animation off restores it.
    const lineStyleValue = vizPrefs.dashedLines || vizPrefs.animateArrows ? 'dashed' : 'normal';

    return (
        <aside className="sigil-options" aria-label="Sigil options">
            <header className="rd-header">
                <div className="rd-title">
                    <span className="rd-type">Sigil</span>
                    <span className="rd-name">Options</span>
                </div>
                <button type="button" className="rd-close" onClick={onClose} aria-label="Close options">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                </button>
            </header>

            <div className="rd-body so-body">
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

                {/* Cosmetic — how this sigil's diagram displays (frontend-only; never changes what the
                    agent generates, and carries into exports of this sigil too) */}
                <div className="ca-field-label ca-field-label-spaced">Diagram display</div>
                <div className="so-viz">
                    <Row title="Connection labels" hint="Show what each connection does (e.g. &quot;GET /api/ec2&quot;) as a label on it.">
                        <Segment label="Connection labels" options={ON_OFF}
                            value={vizPrefs.showConnectionLabels ? 'on' : 'off'}
                            onChange={(v) => setVizPref('showConnectionLabels', v === 'on')} />
                    </Row>
                    <Row title="Step numbers" hint={hasSteps
                        ? 'Prefix each connection with its workflow step order (e.g. &quot;2. GET /orders&quot;).'
                        : 'This diagram has no workflow step order to number.'}>
                        <Segment label="Step numbers" options={ON_OFF}
                            value={vizPrefs.showStepNumbers ? 'on' : 'off'}
                            onChange={(v) => setVizPref('showStepNumbers', v === 'on')}
                            disabledValues={(vizPrefs.showConnectionLabels && hasSteps) ? [] : ['on', 'off']} />
                    </Row>
                    <Row title="Service names" hint="The AWS service name shown under each icon (e.g. &quot;S3&quot;, &quot;DynamoDB&quot;).">
                        <Segment label="Service names" options={ON_OFF}
                            value={vizPrefs.showServiceLabels ? 'on' : 'off'}
                            onChange={(v) => setVizPref('showServiceLabels', v === 'on')} />
                    </Row>
                    <Row title="Group boxes" hint="The colored category boxes around related services (Compute, Messaging, Data…).">
                        <Segment label="Group boxes" options={ON_OFF}
                            value={vizPrefs.showGroupBoxes ? 'on' : 'off'}
                            onChange={(v) => setVizPref('showGroupBoxes', v === 'on')} />
                    </Row>
                    <Row title="Internet / external client" hint="The external actor (Internet, user, browser…) and the connection it makes to your services.">
                        <Segment label="Internet / external client" options={ON_OFF}
                            value={vizPrefs.showExternalActor ? 'on' : 'off'}
                            onChange={(v) => setVizPref('showExternalActor', v === 'on')} />
                    </Row>
                    <Row title="Line thickness" hint="How thick the connection lines are drawn.">
                        <Slider label="Line thickness"
                            min={THICK_MIN} max={THICK_MAX} step={THICK_STEP}
                            value={vizPrefs.lineThickness}
                            onChange={(v) => setVizPref('lineThickness', v)}
                            readout={`${Number(vizPrefs.lineThickness).toFixed(1)} px`} />
                    </Row>
                    <Row
                        title="Line style"
                        hint={vizPrefs.animateArrows
                            ? 'Locked to Dashed while Animated flow is on.'
                            : 'Connections drawn as a continuous line, or as dashed segments.'}
                    >
                        <Segment label="Line style" options={LINE_STYLE_OPTIONS}
                            value={lineStyleValue}
                            onChange={(v) => setVizPref('dashedLines', v === 'dashed')}
                            disabledValues={vizPrefs.animateArrows ? ['normal'] : []} />
                    </Row>
                    <Row title="Animated flow" hint="Dashed lines flow along each connection, in the direction of the arrow.">
                        <Segment label="Animated flow" options={ON_OFF}
                            value={vizPrefs.animateArrows ? 'on' : 'off'}
                            onChange={(v) => setVizPref('animateArrows', v === 'on')} />
                    </Row>
                    <Row title="Animation speed" hint="How fast the dashes flow. Only applies while Animated flow is on.">
                        <Slider label="Animation speed"
                            min={SPEED_MIN} max={SPEED_MAX} step={SPEED_STEP}
                            value={SPEED_MIN + SPEED_MAX - vizPrefs.animationSpeed}
                            onChange={(raw) => setVizPref('animationSpeed', Number((SPEED_MIN + SPEED_MAX - raw).toFixed(2)))}
                            disabled={!vizPrefs.animateArrows}
                            minLabel="Slow" maxLabel="Fast" />
                    </Row>
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
        </aside>
    );
}
