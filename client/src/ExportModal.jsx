import { useEffect, useMemo, useRef, useState } from 'react';
import { useDeployed } from './DeployedContext.js';
import { exportDiagram, exportFilename, svgSize, CANVAS_BG, buildExportSvg } from './exportDiagram.js';
import { sanitizeId } from './svgClassify.js';
import Segment from './Segment.jsx';

const FORMATS = [['png', 'PNG'], ['jpg', 'JPG'], ['svg', 'SVG']];
const SCALES = [1, 2, 3];

function iconWarningText(n) {
    return `${n} icon${n === 1 ? '' : 's'} could not be loaded and ${n === 1 ? 'is' : 'are'} missing from the file.`;
}

// "Export sigil" pop-up: download the current diagram as PNG / JPG / SVG. Exports the SVG the
// backend rendered (via context) rather than the on-screen DOM, so the file is the clean diagram —
// no selection glow, no divergence badges, no app CSS it couldn't carry anyway.
export default function ExportModal({ onClose }) {
    const { svg, selectedChat, vizPrefs, resources } = useDeployed();
    // Same sanitized-id membership Diagram.jsx uses live, so the export pipeline tells a semantic
    // group box apart from a resource node identically to the on-screen canvas.
    const resourceIds = useMemo(
        () => new Set((resources || []).map((r) => sanitizeId(r.id)).filter(Boolean)),
        [resources]
    );
    const [format, setFormat] = useState('png');
    const [scale, setScale] = useState(2);
    const [transparent, setTransparent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [warning, setWarning] = useState('');
    // Live preview: an object URL for the exact same self-contained SVG (icons inlined, background
    // applied) that a download would produce — never a separate re-derivation, so what you see here
    // is genuinely what you'd get.
    const [previewUrl, setPreviewUrl] = useState('');
    const [previewLoading, setPreviewLoading] = useState(true);
    const [previewFailed, setPreviewFailed] = useState(0);
    const previewUrlRef = useRef('');

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

    // Rebuild the preview only when the diagram, the background choice, or the display
    // preferences (labels/groups/animation, from Sigil Options) change — format (PNG vs JPG vs
    // SVG) and scale never change what the diagram LOOKS like, only how it's encoded/sized, so
    // there's no reason to redo icon-fetching for those. `background` already folds in the
    // JPG-forces-opaque rule, so switching format still updates the preview when that rule kicks in.
    // Including vizPrefs means the preview is honest the moment the modal opens, not just when a
    // toggle changes while it happens to be open — export always matches what's on screen right now.
    useEffect(() => {
        if (!svg) return;
        let cancelled = false;
        setPreviewLoading(true);
        (async () => {
            try {
                const { markup, failedIcons } = await buildExportSvg(svg, { background, vizPrefs, resourceIds });
                if (cancelled) return;
                const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
                if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
                previewUrlRef.current = url;
                setPreviewUrl(url);
                setPreviewFailed(failedIcons);
            } catch {
                if (!cancelled) setPreviewUrl('');
            } finally {
                if (!cancelled) setPreviewLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [svg, background, vizPrefs, resourceIds]);

    // Revoke the last object URL when the modal itself unmounts.
    useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);

    async function download() {
        setBusy(true);
        setError('');
        setWarning('');
        try {
            const { failedIcons } = await exportDiagram(svg, { format, scale, background, name, vizPrefs, resourceIds });
            if (failedIcons > 0) {
                setWarning(iconWarningText(failedIcons));
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
                    {/* Live preview: the exact self-contained SVG a download would produce (icons
                        inlined, background applied), shown small before committing to anything. A
                        checkerboard shows through wherever the export is genuinely transparent. */}
                    <div className={`ex-preview ${useTransparent ? 'has-checker' : ''}`}>
                        {previewUrl && (
                            <img
                                className={`ex-preview-img ${previewLoading ? 'is-loading' : ''}`}
                                src={previewUrl}
                                alt="Export preview"
                            />
                        )}
                        {previewLoading && <span className="ex-preview-status">Loading preview…</span>}
                        {!previewLoading && !previewUrl && (
                            <span className="ex-preview-status">Preview unavailable</span>
                        )}
                    </div>

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
                    {/* The preview build already caught a missing icon — no need to wait for a
                        download attempt to tell the user. */}
                    {(warning || (previewFailed > 0 && iconWarningText(previewFailed))) && (
                        <p className="token-hint token-danger" role="alert">
                            {warning || iconWarningText(previewFailed)}
                        </p>
                    )}

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
