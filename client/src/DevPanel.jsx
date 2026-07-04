import { useCallback, useEffect, useRef, useState } from 'react';

// Bottom drawer (VS Code panel style) with tabs. Two kinds of tabs:
//   - type 'port' (opencode): probes localhost:<port> and iframes it when reachable.
//   - type 'url'  (Claude Code): the user runs `claude remote-control`, which prints a
//     web link; they paste that link and we iframe it. Strictly validated to start with
//     https://claude.ai/code.
// Hidden by default; pop it up from the bottom bar, resize it, switch tabs. The panel is a
// flex child of `.app`, so expanding it pushes `<main>` up (the diagram refits itself).
//
// `embedded` mode (Agent (MCP) view): the panel lives inside a dockview pane, so dockview
// owns its position/size/close. In that mode we always render the expanded content and drop
// our own chrome (the collapse bar, the resize handle, and the close buttons). Tab/port/url
// state is still persisted, so it keeps working the same.

const CLAUDE_URL_PREFIX = 'https://claude.ai/code';

const TABS = [
    {
        id: 'opencode',
        label: 'opencode',
        type: 'port',
        defaultPort: 4096,
        hint: (p) => (
            <>Start it with <code>opencode serve --port {p}</code>, then refresh.</>
        )
    },
    {
        id: 'claudecode',
        label: 'Claude Code',
        type: 'url',
        urlPrefix: CLAUDE_URL_PREFIX
    }
];

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 140;
const PROBE_TIMEOUT_MS = 2500;

function readStored(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v;
    } catch {
        return fallback;
    }
}

function store(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // ignore (private mode / disabled storage)
    }
}

function initialPorts() {
    const ports = {};
    for (const tab of TABS) {
        if (tab.type !== 'port') continue;
        const p = parseInt(readStored(`devpanel.port.${tab.id}`, tab.defaultPort), 10);
        ports[tab.id] = Number.isFinite(p) ? p : tab.defaultPort;
    }
    return ports;
}

function initialUrls() {
    const urls = {};
    for (const tab of TABS) {
        if (tab.type !== 'url') continue;
        urls[tab.id] = readStored(`devpanel.url.${tab.id}`, '');
    }
    return urls;
}

export default function DevPanel({ embedded = false }) {
    const [collapsed, setCollapsed] = useState(() => readStored('devpanel.collapsed', 'true') !== 'false');
    const [height, setHeight] = useState(() => {
        const h = parseInt(readStored('devpanel.height', DEFAULT_HEIGHT), 10);
        return Number.isFinite(h) ? h : DEFAULT_HEIGHT;
    });
    const [activeTab, setActiveTab] = useState(() => {
        const t = readStored('devpanel.tab', TABS[0].id);
        return TABS.some((x) => x.id === t) ? t : TABS[0].id;
    });
    const [ports, setPorts] = useState(initialPorts);
    const [urls, setUrls] = useState(initialUrls);
    const [status, setStatus] = useState({}); // port tabs: { [id]: unknown|checking|up|down }
    const [reloadKey, setReloadKey] = useState({});
    const [portDraft, setPortDraft] = useState('');
    const [urlDraft, setUrlDraft] = useState('');
    const [urlError, setUrlError] = useState('');
    const [resizing, setResizing] = useState(false);

    const panelRef = useRef(null);
    const heightRef = useRef(height);

    const tab = TABS.find((t) => t.id === activeTab) || TABS[0];
    const port = ports[activeTab];
    const url = urls[activeTab] || '';
    const validUrl = tab.type === 'url' && url.startsWith(CLAUDE_URL_PREFIX);

    // Best-effort reachability check for a port tab. `no-cors` yields an opaque response we
    // can't read, but the promise only resolves if something answered on that port.
    const probe = useCallback(async (id) => {
        const t = TABS.find((x) => x.id === id);
        if (!t || t.type !== 'port') return;
        const p = ports[id];
        setStatus((s) => ({ ...s, [id]: 'checking' }));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
            await fetch(`http://localhost:${p}/`, { mode: 'no-cors', signal: controller.signal });
            setStatus((s) => ({ ...s, [id]: 'up' }));
            setReloadKey((r) => ({ ...r, [id]: (r[id] || 0) + 1 }));
        } catch {
            setStatus((s) => ({ ...s, [id]: 'down' }));
        } finally {
            clearTimeout(timer);
        }
    }, [ports]);

    // Probe the active port tab whenever the panel is open and the tab/port changes.
    useEffect(() => {
        if (!collapsed && tab.type === 'port') {
            probe(activeTab);
        }
    }, [collapsed, activeTab, port, probe, tab.type]);

    useEffect(() => { store('devpanel.collapsed', collapsed); }, [collapsed]);
    useEffect(() => { store('devpanel.tab', activeTab); }, [activeTab]);
    // Keep the draft fields in sync with the active tab.
    useEffect(() => {
        if (tab.type === 'port') setPortDraft(String(ports[activeTab]));
        if (tab.type === 'url') setUrlDraft(urls[activeTab] || '');
        setUrlError('');
    }, [activeTab, ports, urls, tab.type]);

    const open = () => setCollapsed(false);
    const close = () => setCollapsed(true);

    function refresh() {
        if (tab.type === 'port') probe(activeTab);
        else if (validUrl) setReloadKey((r) => ({ ...r, [activeTab]: (r[activeTab] || 0) + 1 }));
    }

    function applyPort() {
        const p = parseInt(portDraft, 10);
        if (Number.isFinite(p) && p > 0 && p <= 65535 && p !== port) {
            setPorts((prev) => ({ ...prev, [activeTab]: p }));
            store(`devpanel.port.${activeTab}`, p);
        } else {
            setPortDraft(String(port)); // revert invalid input
        }
    }

    // Strict validation: the link must start with https://claude.ai/code.
    function openUrl() {
        const u = urlDraft.trim();
        if (!u.startsWith(CLAUDE_URL_PREFIX)) {
            setUrlError(`The link must start with ${CLAUDE_URL_PREFIX}`);
            return;
        }
        setUrlError('');
        setUrls((prev) => ({ ...prev, [activeTab]: u }));
        store(`devpanel.url.${activeTab}`, u);
        setReloadKey((r) => ({ ...r, [activeTab]: (r[activeTab] || 0) + 1 }));
    }

    // Clear the loaded link to show the input again (keeps the value for editing).
    function changeLink() {
        setUrlDraft(url);
        setUrls((prev) => ({ ...prev, [activeTab]: '' }));
        store(`devpanel.url.${activeTab}`, '');
        setUrlError('');
    }

    // claude.ai sends X-Frame-Options: SAMEORIGIN, so it can't be embedded in an iframe —
    // the only way to use it is to open the link in a new tab.
    function openExternal() {
        if (validUrl) window.open(url, '_blank', 'noopener,noreferrer');
    }

    // Vertical resize: mutate the CSS var live during the drag, commit on mouseup (dragging up
    // grows it). While dragging, stop the iframe from swallowing the mouse events.
    const startResize = useCallback((e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startHeight = heightRef.current;
        const panel = panelRef.current;
        if (!panel) return;
        const max = () => Math.round(window.innerHeight * 0.8);

        const onMove = (ev) => {
            const next = Math.max(MIN_HEIGHT, Math.min(max(), startHeight + (startY - ev.clientY)));
            panel.style.setProperty('--devpanel-h', `${next}px`);
        };
        const onUp = () => {
            const raw = panel.style.getPropertyValue('--devpanel-h');
            const finalH = raw ? parseInt(raw, 10) : startHeight;
            heightRef.current = finalH;
            setHeight(finalH);
            store('devpanel.height', finalH);
            setResizing(false);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
        };
        setResizing(true);
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    if (collapsed && !embedded) {
        return (
            <button type="button" className="devpanel-bar" onClick={open} aria-expanded="false" title="Open dev panel">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="18 15 12 9 6 15" />
                </svg>
                <span className="devpanel-bar-label">{tab.label}</span>
            </button>
        );
    }

    const activeStatus = status[activeTab] || 'unknown';

    return (
        <section
            className={embedded ? 'devpanel-panel devpanel-embedded' : 'devpanel-panel'}
            ref={panelRef}
            style={embedded ? undefined : { '--devpanel-h': `${height}px` }}
            aria-label="Dev panel"
        >
            {!embedded && (
                <div className="devpanel-resize" onMouseDown={startResize} role="separator" aria-orientation="horizontal" title="Drag to resize" />
            )}
            <header className="devpanel-header">
                {!embedded && (
                    <button type="button" className="icon-btn" onClick={close} title="Hide panel" aria-label="Hide panel">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>
                )}
                <div className="devpanel-tabs" role="tablist">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={t.id === activeTab}
                            className={`devpanel-tab ${t.id === activeTab ? 'is-active' : ''}`}
                            onClick={() => setActiveTab(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {tab.type === 'port' && (
                    <>
                        <span className={`devpanel-dot devpanel-dot-${activeStatus}`} aria-hidden="true" />
                        <span className="devpanel-status-text">
                            {activeStatus === 'up' ? 'connected'
                                : activeStatus === 'checking' ? 'checking…'
                                : activeStatus === 'down' ? 'not running'
                                : ''}
                        </span>
                        <span className="devpanel-spacer" />
                        <label className="devpanel-port-field">
                            <span>localhost:</span>
                            <input
                                className="devpanel-port"
                                type="number"
                                min="1"
                                max="65535"
                                value={portDraft}
                                onChange={(e) => setPortDraft(e.target.value)}
                                onBlur={applyPort}
                                onKeyDown={(e) => { if (e.key === 'Enter') applyPort(); }}
                                aria-label={`${tab.label} port`}
                            />
                        </label>
                    </>
                )}

                {tab.type === 'url' && (
                    <>
                        <span className={`devpanel-dot ${validUrl ? 'devpanel-dot-up' : 'devpanel-dot-down'}`} aria-hidden="true" />
                        <span className="devpanel-status-text">{validUrl ? 'linked' : 'no link'}</span>
                        <span className="devpanel-spacer" />
                        {validUrl && (
                            <button type="button" className="link-btn" onClick={changeLink}>Change link</button>
                        )}
                    </>
                )}

                {tab.type === 'port' && (
                    <button type="button" className="icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                    </button>
                )}
                {!embedded && (
                    <button type="button" className="icon-btn" onClick={close} title="Close panel" aria-label="Close panel">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                )}
            </header>

            <div className="devpanel-body">
                {tab.type === 'port' ? (
                    activeStatus === 'up' ? (
                        <iframe
                            className="devpanel-iframe"
                            key={`${activeTab}-${reloadKey[activeTab] || 0}`}
                            src={`http://localhost:${port}`}
                            title={tab.label}
                            style={{ pointerEvents: resizing ? 'none' : 'auto' }}
                        />
                    ) : (
                        <div className="devpanel-empty">
                            <img className="devpanel-brand-logo" src="/opencode.png" alt="" aria-hidden="true" />
                            {activeStatus === 'checking' ? (
                                <p>Checking <code>{`localhost:${port}`}</code>…</p>
                            ) : (
                                <>
                                    <p className="devpanel-empty-title">No {tab.label} on <code>{`localhost:${port}`}</code></p>
                                    <p>{tab.hint(port)}</p>
                                    <div className="devpanel-empty-actions">
                                        <label className="devpanel-port-field">
                                            <span>Port</span>
                                            <input
                                                className="devpanel-port"
                                                type="number"
                                                min="1"
                                                max="65535"
                                                value={portDraft}
                                                onChange={(e) => setPortDraft(e.target.value)}
                                                onBlur={applyPort}
                                                onKeyDown={(e) => { if (e.key === 'Enter') applyPort(); }}
                                                aria-label={`${tab.label} port`}
                                            />
                                        </label>
                                        <button type="button" className="details-save-btn" onClick={refresh}>Refresh</button>
                                    </div>
                                </>
                            )}
                        </div>
                    )
                ) : validUrl ? (
                    <div className="devpanel-empty">
                        <span className="devpanel-empty-icon" aria-hidden="true">⌘</span>
                        <p className="devpanel-empty-title">Claude Code session linked</p>
                        <p className="devpanel-link-url"><code>{url}</code></p>
                        <button type="button" className="details-save-btn devpanel-open-btn" onClick={openExternal}>
                            Open Claude Code ↗
                        </button>
                        <p className="devpanel-aside">
                            claude.ai can't be embedded in a frame (it sends <code>X-Frame-Options</code>),
                            so it opens in a new tab.
                        </p>
                    </div>
                ) : (
                    <div className="devpanel-empty">
                        <span className="devpanel-empty-icon" aria-hidden="true">⌘</span>
                        <p className="devpanel-empty-title">Open Claude Code Remote Control</p>
                        <p>
                            In your terminal, run <code>claude remote-control</code>. It prints a web
                            link for the session — paste that link below to open it.
                        </p>
                        <div className="devpanel-empty-actions">
                            <input
                                className="devpanel-url"
                                type="url"
                                placeholder="https://claude.ai/code/…"
                                value={urlDraft}
                                onChange={(e) => setUrlDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') openUrl(); }}
                                aria-label="Claude Code Remote Control link"
                            />
                            <button type="button" className="details-save-btn" onClick={openUrl}>Open</button>
                        </div>
                        {urlError
                            ? <p className="devpanel-error">{urlError}</p>
                            : <p className="devpanel-aside">The link must start with <code>{CLAUDE_URL_PREFIX}</code>.</p>}
                    </div>
                )}
            </div>
        </section>
    );
}
