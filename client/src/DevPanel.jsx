import { useCallback, useEffect, useRef, useState } from 'react';

// Bottom drawer (VS Code panel style) for opencode: probes localhost:<port> and iframes it
// when reachable. Hidden by default; pop it up from the bottom bar, resize it. The panel is a
// flex child of `.app`, so expanding it pushes `<main>` up (the diagram refits itself).
//
// `embedded` mode (Sigils view): the panel lives inside a dockview pane, so dockview owns its
// position/size/close. In that mode we always render the expanded content and drop our own
// chrome (the collapse bar, the resize handle, and the close buttons). Port state is still
// persisted, so it keeps working the same.

const TABS = [
    {
        id: 'opencode',
        label: 'opencode',
        type: 'port',
        defaultPort: 4096,
        hint: (p) => (
            <>Start it with <code>opencode serve --port {p}</code>, then refresh.</>
        )
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
    const [status, setStatus] = useState({}); // port tabs: { [id]: unknown|checking|up|down }
    const [reloadKey, setReloadKey] = useState({});
    const [portDraft, setPortDraft] = useState('');
    const [resizing, setResizing] = useState(false);

    const panelRef = useRef(null);
    const heightRef = useRef(height);

    const tab = TABS.find((t) => t.id === activeTab) || TABS[0];
    const port = ports[activeTab];

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
    // Keep the draft field in sync with the active tab.
    useEffect(() => {
        if (tab.type === 'port') setPortDraft(String(ports[activeTab]));
    }, [activeTab, ports, tab.type]);

    const open = () => setCollapsed(false);
    const close = () => setCollapsed(true);

    function refresh() {
        if (tab.type === 'port') probe(activeTab);
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
                <div className="devpanel-tabs">
                    <span className="devpanel-tab is-active">opencode</span>
                </div>

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

                <button type="button" className="icon-btn" onClick={refresh} title="Refresh" aria-label="Refresh">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                </button>
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
                {activeStatus === 'up' ? (
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
                                        <button type="button" className="btn btn-primary" onClick={refresh}>Refresh</button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
            </div>
        </section>
    );
}
