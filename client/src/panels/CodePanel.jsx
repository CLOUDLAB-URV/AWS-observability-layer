import { useEffect, useRef, useState } from 'react';
import { useDeployed } from '../DeployedContext.js';
import { highlightCode } from '../highlight.js';

// The Code window: shows the source a resource runs (Lambda handler, EC2 user-data, …).
// Opened from the "View code" button in a resource's detail panel. Scoped to one resource
// at a time via `codeView` ({ resourceId, fileName }); purely a viewer — it never edits state.
export default function CodePanel(props) {
    const { codeView, resources, setCodeView } = useDeployed();
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef(null);
    // Which file the user is looking at (the tab). Reset when the target resource/file changes.
    const [activeName, setActiveName] = useState(codeView?.fileName || null);
    useEffect(() => () => clearTimeout(copiedTimer.current), []);
    useEffect(() => {
        setActiveName(codeView?.fileName || null);
    }, [codeView?.resourceId, codeView?.fileName]);

    const resource = codeView
        ? (resources || []).find((r) => r.id === codeView.resourceId) || null
        : null;
    const files = (Array.isArray(resource?.code) ? resource.code : []).filter(
        (file) => file && typeof file === 'object' && file.name && typeof file.content === 'string'
    );

    if (!codeView || !resource || files.length === 0) {
        return <div className="dv-pane dv-pane-empty">No code selected. Pick “View code” on a resource.</div>;
    }

    const active = files.find((f) => f.name === activeName) || files[0];

    async function copy() {
        try {
            await navigator.clipboard.writeText(active.content);
            setCopied(true);
            clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable — the text stays selectable */ }
    }

    const html = highlightCode(active.content, active.language);

    return (
        <div className="dv-pane code-pane">
            <header className="rd-header">
                <div className="rd-title">
                    <span className="rd-type">Code</span>
                    <span className="rd-name">{resource.name || resource.id || '—'}</span>
                </div>
                <button type="button" className="rd-close" onClick={() => { setCodeView(null); props.api?.close(); }}
                    aria-label="Close code">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                </button>
            </header>

            {files.length > 1 && (
                <div className="code-tabs" role="tablist">
                    {files.map((file, i) => (
                        <button
                            key={`${file.name}-${i}`}
                            type="button"
                            role="tab"
                            aria-selected={file.name === active.name}
                            className={`code-tab ${file.name === active.name ? 'is-active' : ''}`}
                            onClick={() => setActiveName(file.name)}
                            title={file.name}
                        >
                            {file.name}
                        </button>
                    ))}
                </div>
            )}

            <div className="code-toolbar">
                <span className="code-filename">
                    {active.name}
                    {active.language && <span className="code-lang">{active.language}</span>}
                </span>
                <button type="button" className="code-copy" onClick={copy} title="Copy code"
                    aria-label="Copy code to clipboard">
                    {copied ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 6L9 17l-5-5" />
                        </svg>
                    ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                    )}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>

            <pre className="code-window">
                <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
        </div>
    );
}
