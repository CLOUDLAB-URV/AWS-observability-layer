import { useEffect, useState } from 'react';
import { useDeployed } from './DeployedContext.js';
import { exportDiagram, exportFilename, svgSize, CANVAS_BG } from './exportDiagram.js';

const FORMATS = [['png', 'PNG'], ['jpg', 'JPG'], ['svg', 'SVG']];
const SCALES = [1, 2, 3];

// Segmented control, same shape as the agent picker in ConnectAgentModal.
function Segment({ label, options, value, onChange, disabledValues = [] }) {
    return (
        <div className="ca-segment" role="group" aria-label={label}>
            {options.map(([id, text]) => {
                const disabled = disabledValues.includes(id);
                return (
                    <button
                        key={id}
                        type="button"
                        className={`ca-segment-btn ${value === id ? 'is-active' : ''}`}
                        aria-pressed={value === id}
                        disabled={disabled}
                        onClick={() => onChange(id)}
                    >
                        {text}
                    </button>
                );
            })}
        </div>
    );
}

// "Export sigil" pop-up: download the current diagram as PNG / JPG / SVG. Exports the SVG the
// backend rendered (via context) rather than the on-screen DOM, so the file is the clean diagram —
// no selection glow, no divergence badges, no app CSS it couldn't carry anyway.
export default function ExportModal({ onClose }) {
    const { svg, selectedChat } = useDeployed();
    const [format, setFormat] = useState('png');
    const [scale, setScale] = useState(2);
    const [transparent, setTransparent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [warning, setWarning] = useState('');

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const size = svgSize(svg);
    const isRaster = format !== 'svg';
    // JPEG has no alpha channel, so it can never be transparent.
    const canBeTransparent = format !== 'jpg';
    const useTransparent = transparent && canBeTransparent;
    const background = useTransparent ? null : CANVAS_BG;
    const name = selectedChat?.name || '';

    const out = size && isRaster
        ? { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
        : size;

    async function download() {
        setBusy(true);
        setError('');
        setWarning('');
        try {
            const { failedIcons } = await exportDiagram(svg, { format, scale, background, name });
            if (failedIcons > 0) {
                setWarning(`${failedIcons} icon${failedIcons === 1 ? '' : 's'} could not be loaded and ${failedIcons === 1 ? 'is' : 'are'} missing from the file.`);
            } else {
                onClose();
            }
        } catch (e) {
            setError(e?.message || 'The export failed. Try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ex-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal-box modal-box-wide">
                <div className="ca-head">
                    <h2 className="modal-title" id="ex-title">
                        <svg className="so-title-icon" viewBox="0 0 24 24" width="17" height="17" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                            aria-hidden="true">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Export sigil
                    </h2>
                    <button type="button" className="rd-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="ca-body ex-body">
                    <div className="ex-row">
                        <span className="ca-field-label">Format</span>
                        <Segment label="Export format" options={FORMATS} value={format} onChange={setFormat} />
                    </div>
                    <p className="ca-hint">
                        {format === 'svg'
                            ? 'Vector — scales to any size and stays sharp. Best for slides and docs.'
                            : format === 'png'
                                ? 'Lossless raster, supports a transparent background.'
                                : 'Smaller file, no transparency — always exported on a solid background.'}
                    </p>

                    {isRaster && (
                        <div className="ex-row ex-row-spaced">
                            <span className="ca-field-label">Size</span>
                            <Segment
                                label="Export scale"
                                options={SCALES.map((s) => [s, `${s}×`])}
                                value={scale}
                                onChange={setScale}
                            />
                        </div>
                    )}

                    <div className="ex-row ex-row-spaced">
                        <span className="ca-field-label">Background</span>
                        <Segment
                            label="Export background"
                            options={[['canvas', 'Canvas'], ['transparent', 'Transparent']]}
                            value={useTransparent ? 'transparent' : 'canvas'}
                            onChange={(v) => setTransparent(v === 'transparent')}
                            disabledValues={canBeTransparent ? [] : ['transparent']}
                        />
                    </div>
                    {!canBeTransparent && (
                        <p className="ca-hint">JPG has no transparency — it always gets the dark canvas.</p>
                    )}

                    <div className="ex-summary">
                        <code className="ex-filename">{exportFilename(name, format)}</code>
                        <span className="ex-dims">
                            {out ? `${out.width} × ${out.height} px` : 'Unknown size'}
                            {format === 'svg' ? ' · vector' : ''}
                        </span>
                    </div>

                    {error && <p className="token-hint token-danger" role="alert">{error}</p>}
                    {warning && <p className="token-hint token-danger" role="alert">{warning}</p>}

                    <div className="ca-actions">
                        <button type="button" className="btn btn-primary" onClick={download} disabled={busy || !svg}>
                            {busy ? 'Exporting…' : 'Download'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
