import { useEffect, useRef, useState, useCallback } from 'react';
import { DockviewReact, themeAbyss } from 'dockview-react';
import { createSocket } from './ws.js';
import { DeployedContext } from './DeployedContext.js';
import DiagramPanel from './panels/DiagramPanel.jsx';
import ResourceDetailPanel from './panels/ResourceDetailPanel.jsx';
import ExplanationPanel from './panels/ExplanationPanel.jsx';
import DetailsPanel from './panels/DetailsPanel.jsx';
import ConnectAgentPanel from './panels/ConnectAgentPanel.jsx';
import GuidePanel from './panels/GuidePanel.jsx';
import DevToolsPanel from './panels/DevToolsPanel.jsx';

const TOKEN_LIMIT = 3;
const TOKEN_PLACEHOLDER = 'viz_your_token_here';

// dockview panel registry (id → component). The layout is a rigid VSCode-like model: the
// diagram is the fixed, locked centre anchor (like the editor) and every other panel lives in
// one of exactly three zones — left / right (full-height columns) or bottom (a strip under the
// diagram, between the columns). At most ONE group per zone; panels opened into the same zone
// stack as tabs. Side columns keep a fixed pixel width (persisted per zone); only the diagram
// grows when the window widens.
const PANEL_COMPONENTS = {
    diagram: DiagramPanel,
    'resource-detail': ResourceDetailPanel,
    explanation: ExplanationPanel,
    details: DetailsPanel,
    'connect-agent': ConnectAgentPanel,
    guide: GuidePanel,
    devtools: DevToolsPanel
};
// Each panel's DEFAULT zone. The user can move a panel to another zone; that choice is
// remembered (see zone memory below) and used when the panel is reopened.
const PANEL_META = {
    'connect-agent': { title: 'Connect agent', zone: 'right' },
    details: { title: 'Details', zone: 'right' },
    explanation: { title: 'Explanation', zone: 'right' },
    guide: { title: 'Guide', zone: 'right' },
    'resource-detail': { title: 'Resource', zone: 'right' },
    devtools: { title: 'opencode', zone: 'left' }
};
// Zone → the dockview direction used to create that zone's group next to the diagram.
const ZONE_DIRECTION = { left: 'left', right: 'right', bottom: 'below' };
// The panel a zone toggle opens when its zone is empty AND nothing was remembered (VSCode
// opens the default view when you toggle an empty sidebar on). Bottom has no default → its
// toggle stays disabled until something lives there.
const ZONE_DEFAULT_PANEL = { left: 'devtools', right: 'guide', bottom: null };

// A close-less tab renderer for the diagram: it's the anchor panel, so it must not be
// closable (no ✕, and none exists). Every other panel keeps the default closable tab.
function PlainTab(props) {
    return <div className="dv-plain-tab" title={props.api.title}>{props.api.title}</div>;
}
const TAB_COMPONENTS = { plain: PlainTab };

// Root-edge drop targets — the ONLY way to create an empty zone (drag a panel to a screen
// edge). A 60px activation band (the library default of 10px is nearly impossible to hit);
// the overlay is a fixed-pixel strip so the preview reads like the side column it becomes
// (see zoneCreateSize / onWillDrop, which then lands it at the exact per-zone width).
const DND_EDGES = {
    activationSize: { type: 'pixels', value: 60 },
    size: { type: 'pixels', value: 360 }
};

// Never degrade the drop highlight to the thin 1px border indicator on small groups — the
// full-zone highlight is always shown, so the preview reads the same everywhere.
const DROP_OVERLAY_MODEL = () => ({ smallWidthBoundary: 0, smallHeightBoundary: 0 });

// Default size each zone regenerates to when it is (re)created and the user hasn't resized
// it before: a readable width for the side columns, a compact strip for the bottom. Persisted
// per-zone user sizes (see loadSizes) override these; a size is still capped so it can never
// swallow the diagram (L/R ≤45% of the dock width, bottom ≤50% of its height).
const ZONE_DEFAULT_SIZE = { left: 360, right: 360, bottom: 260 };
function zoneCreateSize(zone, dockEl, sizes) {
    const stored = sizes && sizes[zone];
    if (zone === 'bottom') {
        const h = dockEl?.clientHeight || 800;
        return Math.min(stored || ZONE_DEFAULT_SIZE.bottom, Math.round(h * 0.5));
    }
    const w = dockEl?.clientWidth || 1200;
    return Math.min(stored || ZONE_DEFAULT_SIZE[zone], Math.round(w * 0.45));
}

// Bump the suffixes when panel ids / defaults change so stale saved state is ignored.
// (v7 = rigid 4-zone VSCode model, superseding the v6 free-tiling layout.)
const LAYOUT_KEY = 'viz-dock-layout-v7';
const ZONES_KEY = 'viz-dock-zones-v7';
const SIZES_KEY = 'viz-dock-sizes-v7';
const HIDDEN_KEY = 'viz-dock-hidden-v7';
// The sigil (chat) the user last had selected, so it reopens on reload / revisit.
const CHAT_KEY = 'viz-current-chat';

// Per-panel remembered zone, persisted so reopening a panel returns it to where the user
// last left it. Seeded from the defaults above.
const DEFAULT_ZONES = Object.fromEntries(Object.entries(PANEL_META).map(([id, m]) => [id, m.zone]));
function loadZones() {
    try {
        const saved = JSON.parse(localStorage.getItem(ZONES_KEY) || '{}');
        return { ...DEFAULT_ZONES, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch {
        return { ...DEFAULT_ZONES };
    }
}
function saveZones(zones) {
    try { localStorage.setItem(ZONES_KEY, JSON.stringify(zones)); } catch { /* quota */ }
}

// Per-zone remembered pixel size (left/right width, bottom height), persisted so a column the
// user widened comes back the same width next time it's opened. Seeded from ZONE_DEFAULT_SIZE.
function loadSizes() {
    try {
        const saved = JSON.parse(localStorage.getItem(SIZES_KEY) || '{}');
        return { ...ZONE_DEFAULT_SIZE, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch {
        return { ...ZONE_DEFAULT_SIZE };
    }
}
function saveSizes(sizes) {
    try { localStorage.setItem(SIZES_KEY, JSON.stringify(sizes)); } catch { /* quota */ }
}

// Hidden zones (VSCode-style show/hide toggles). A zone is "hidden" when its group has been
// removed but its contents are remembered so the toggle (or a drop into that zone) can restore
// them. Shape: { left: { ids: [...], active: id }, right: {...}, bottom: {...} } — a present
// entry means that zone is currently hidden. Persisted so the hidden/shown state survives reload.
function loadHidden() {
    try {
        const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}');
        return saved && typeof saved === 'object' ? saved : {};
    } catch {
        return {};
    }
}
function saveHidden(hidden) {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)); } catch { /* quota */ }
}

// Classify a group's position relative to the diagram group, purely by geometry, into a
// zone (left / right / bottom). Used both to route a panel into an existing zone group and
// to snap zone sizes to thirds.
function zoneOfGroup(group, diagramGroup) {
    if (!group || !diagramGroup || group === diagramGroup) return null;
    const g = group.element.getBoundingClientRect();
    const d = diagramGroup.element.getBoundingClientRect();
    if (g.right <= d.left + 4) return 'left';
    if (g.left >= d.right - 4) return 'right';
    if (g.top + g.height / 2 > d.top + d.height / 2) return 'bottom';
    // Fallback (overlapping rects mid-transition): decide by horizontal centre.
    return (g.left + g.width / 2) < (d.left + d.width / 2) ? 'left' : 'right';
}

// The single group currently occupying a zone (left/right/bottom), or null. Enforces the
// one-group-per-zone invariant: callers stack into it if it exists, else create the zone.
function findZoneGroup(api, zone, diagramGroup) {
    if (!api || !diagramGroup) return null;
    for (const g of api.groups) {
        if (g === diagramGroup || g.id === diagramGroup.id) continue;
        if (zoneOfGroup(g, diagramGroup) === zone) return g;
    }
    return null;
}

// "Deployed state" view: subscribes to one chat on the visualizer socket and
// renders a live diagram of what is actually deployed in AWS (pushed from the
// user's agent via the MCP tool). Each chat has its own isolated diagram. The
// diagram + all side panels live in a VSCode-like dockview layout the user can
// rearrange into the four zones (drag to stack / dock at an edge / resize); the
// arrangement and per-zone sizes are persisted to localStorage.
export default function DeployedState() {
    const [connected, setConnected] = useState(false);
    const [chats, setChats] = useState([]);
    const [chatId, setChatId] = useState(() => {
        try { return localStorage.getItem(CHAT_KEY) || ''; } catch { return ''; }
    });
    const [svg, setSvg] = useState('');
    const [renderError, setRenderError] = useState(null);
    const [newToken, setNewToken] = useState('');
    const [tokens, setTokens] = useState([]);
    const [tokenError, setTokenError] = useState('');
    // Local dev: the backend reports a fixed env token + local URL instead of a generated-token
    // store. When `dev` is true the panel shows that token read-only (no generate/revoke).
    const [dev, setDev] = useState(false);
    const [devToken, setDevToken] = useState('');
    const [visualizerUrl, setVisualizerUrl] = useState('');
    const [confirmRevoke, setConfirmRevoke] = useState('');
    const [copied, setCopied] = useState('');
    const [renameValue, setRenameValue] = useState('');
    const [editingName, setEditingName] = useState(false);
    // Inline two-step confirm for the destructive "Delete diagram" action in the Details panel.
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // Live resource inventory for the selected chat (powers per-service tooltips + the detail
    // panel), and the resource the user clicked in the diagram.
    const [resources, setResources] = useState([]);
    const [selectedResource, setSelectedResource] = useState(null);
    // Mode of the selected diagram: true = "Live" (deployed to AWS), false = "Design" (a sketch).
    const [deployed, setDeployed] = useState(false);
    // On-demand Markdown explanation of the whole diagram: the saved payload (or null),
    // whether it is stale (diagram changed since it was generated), and whether a
    // (re)generation request is in flight. Shown in the dockable "explanation" panel.
    const [explanation, setExplanation] = useState(null); // { markdown, outdated } | null
    const [explaining, setExplaining] = useState(false);
    const socketRef = useRef(null);

    // dockview plumbing: the layout api, a debounce timer for persistence, the set of
    // currently-open panel ids (drives the toolbar toggles' aria-expanded), and a ref
    // mirror of the current selection (read inside the layout-change callback).
    const apiRef = useRef(null);
    const dockRef = useRef(null);           // the .viz-dock container (for width/animation)
    const saveTimer = useRef(null);
    const selectedResourceRef = useRef(null);
    const zonesRef = useRef(loadZones());   // per-panel remembered zone (persisted)
    // Intended pixel size of each zone (left/right width, bottom height). Captured whenever the
    // layout settles at a STABLE container width (a user sash drag or a panel open) and restored
    // verbatim when the whole window resizes, so the side columns keep their pixel width instead of
    // scaling to a third of the window (see the resize handler). `lastContainerWRef` is the width
    // at which the last stable capture happened — a change in it flags a window resize in flight.
    const sizesRef = useRef(loadSizes());
    const lastContainerWRef = useRef(0);
    // Number of groups at the last STABLE layout — a change flags an open/close (topology change),
    // which must re-pin the side columns to their remembered width so only the diagram flexes.
    const lastGroupCountRef = useRef(0);
    // Re-entrancy guards so our own setSize/moveTo calls don't recurse through onDidLayoutChange.
    const reconcilingRef = useRef(false);
    const pinningRef = useRef(false);
    // Zones the user has hidden via the VSCode-style toggles (contents remembered for restore).
    const hiddenRef = useRef(loadHidden());
    const restoringRef = useRef(false);      // guard: hide/show mutations shouldn't recurse
    const [openIds, setOpenIds] = useState([]);
    // Bumped after every hide/show so the toolbar toggle buttons re-render their pressed state.
    const [, setHiddenTick] = useState(0);

    useEffect(() => {
        selectedResourceRef.current = selectedResource;
    }, [selectedResource]);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected, '/ws-visualizer');
        socketRef.current = socket;
        loadChats();
        loadTokens();
        return () => socket.close();
    }, []);

    // (Re)subscribe whenever the active chat changes or we (re)connect. With no chat
    // selected we show nothing — the diagram only loads once the user picks a chat.
    useEffect(() => {
        setSvg('');
        setRenderError(null);
        setSelectedResource(null);
        if (connected && chatId) {
            socketRef.current?.send({ type: 'subscribe', chatId });
        }
    }, [connected, chatId]);

    // Keep the resource inventory in sync with the selected chat: reload on chat change and
    // whenever a new diagram arrives (a push changed the deployed state). Reconcile the open
    // detail panel against the fresh data (update it, or close it if the resource is gone).
    useEffect(() => {
        if (!chatId) {
            setResources([]);
            setDeployed(false);
            setExplanation(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
                const data = await res.json();
                if (cancelled) return;
                const list = Array.isArray(data.resources) ? data.resources : [];
                setResources(list);
                setDeployed(data.deployed === true);
                setSelectedResource((cur) => (cur ? list.find((r) => r.id === cur.id) || null : null));
            } catch {
                if (!cancelled) setResources([]);
            }
        })();
        // Load the saved explanation (if any). Re-runs on [chatId, svg], so when a push
        // changes the diagram the `outdated` flag refreshes without calling the LLM.
        (async () => {
            try {
                const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/explanation`);
                const data = await res.json();
                if (cancelled) return;
                setExplanation(data.markdown ? { markdown: data.markdown, outdated: data.outdated === true } : null);
            } catch {
                if (!cancelled) setExplanation(null);
            }
        })();
        return () => { cancelled = true; };
    }, [chatId, svg]);

    // Persist the selected sigil so a reload / revisit reopens it.
    useEffect(() => {
        try {
            if (chatId) localStorage.setItem(CHAT_KEY, chatId);
            else localStorage.removeItem(CHAT_KEY);
        } catch { /* quota / disabled storage */ }
    }, [chatId]);

    // Keep the rename field in sync with the selected chat's current name, and leave
    // edit mode whenever the selected chat changes.
    useEffect(() => {
        const current = chats.find((c) => c.chatId === chatId);
        setRenameValue(current?.name || '');
        setEditingName(false);
        setConfirmDelete(false);
    }, [chatId, chats]);

    function handleMessage(message) {
        switch (message.type) {
            case 'init':
            case 'render-svg':
                setSvg(message.svg || '');
                setRenderError(message.renderError || null);
                // A push may have created/updated a chat — refresh the list.
                loadChats();
                break;
            case 'error':
                setRenderError(message.message);
                break;
            default:
                break;
        }
    }

    async function loadChats() {
        try {
            const res = await fetch('/api/chats');
            const data = await res.json();
            const list = data.chats || [];
            setChats(list);
            // No auto-select: the diagram only appears once the user picks a chat. But if a
            // persisted selection no longer exists (deleted elsewhere), drop it.
            setChatId((cur) => (cur && !list.some((c) => c.chatId === cur) ? '' : cur));
        } catch {
            setChats([]);
        }
    }

    async function loadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            setTokens(Array.isArray(data.tokens) ? data.tokens : []);
            setDev(Boolean(data.dev));
            setDevToken(data.devToken || '');
            setVisualizerUrl(data.visualizerUrl || '');
        } catch {
            setTokens([]);
        }
    }

    async function generateToken() {
        setTokenError('');
        try {
            const res = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ label: 'web' })
            });
            if (res.status === 409) {
                setTokenError(`Limit reached (${TOKEN_LIMIT}) — revoke one to add a new token.`);
                return;
            }
            const data = await res.json();
            setNewToken(data.token || '');
            loadTokens();
        } catch {
            setTokenError('Could not generate a token. Try again.');
        }
    }

    async function revokeToken(id) {
        try {
            await fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch {
            // ignore — the list refresh below reflects the real state
        }
        setConfirmRevoke('');
        setTokenError('');
        loadTokens();
    }

    // Override the auto-assigned session name for the selected chat.
    async function renameChat() {
        const name = renameValue.trim();
        if (!chatId || !name) return;
        try {
            await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name })
            });
            setEditingName(false);
            loadChats();
        } catch {
            // ignore — the list simply won't update
        }
    }

    function startRename() {
        setRenameValue(selectedChat?.name || '');
        setEditingName(true);
    }

    // Permanently delete the selected diagram, then deselect it (the subscribe/load effects
    // clear svg/resources/explanation for an empty chatId) and refresh the selector. Close the
    // per-chat panels since there's no chat to show anymore.
    async function deleteChat() {
        if (!chatId || deleting) return;
        setDeleting(true);
        try {
            await fetch(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        } catch {
            // ignore — the list refresh below reflects the real state
        }
        setDeleting(false);
        setConfirmDelete(false);
        closePanel('details');
        closePanel('explanation');
        setChatId('');
        loadChats();
    }

    // (Re)generate the diagram explanation. The backend evolves the previous one, so an
    // update after a diagram change is incremental (adds only what changed).
    async function generateExplanation() {
        if (!chatId || explaining) return;
        setExplaining(true);
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/explanation`, { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.markdown) {
                setExplanation({ markdown: data.markdown, outdated: false });
            }
        } catch {
            // ignore — the panel keeps showing the previous explanation (if any)
        } finally {
            setExplaining(false);
        }
    }

    function cancelRename() {
        setRenameValue(selectedChat?.name || '');
        setEditingName(false);
    }

    // ── dockview layout management ──────────────────────────────────────────────
    // Persist the current layout (debounced) so a user's arrangement survives reloads.
    const persist = useCallback((api) => {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON())); } catch { /* quota */ }
        }, 400);
    }, []);

    // Snapshot each zone's current pixel size (left/right width, bottom height) into the persisted
    // per-zone map. Called when the layout is stable (see onDidLayoutChange), so it records the size
    // the user actually set — reasserted when the zone is reopened and on window resize.
    const captureZoneSizes = useCallback(() => {
        const api = apiRef.current;
        const diagramGroup = api?.getPanel('diagram')?.group;
        // Don't record sizes mid-mutation (a reconcile reparent or a pin setSize leaves a group at a
        // transient size for a frame) — that would persist a bogus width/height (e.g. a half-split
        // bottom) as the user's remembered size.
        if (!api || !diagramGroup || reconcilingRef.current || pinningRef.current) return;
        const sizes = { ...sizesRef.current };
        let changed = false;
        for (const g of api.groups) {
            if (g.id === diagramGroup.id) continue;
            const zone = zoneOfGroup(g, diagramGroup);
            if (!zone) continue;
            const r = g.element.getBoundingClientRect();
            const px = Math.round(zone === 'bottom' ? r.height : r.width);
            if (px > 0 && px !== sizes[zone]) { sizes[zone] = px; changed = true; }
        }
        if (changed) { sizesRef.current = sizes; saveSizes(sizes); }
    }, []);

    // Re-pin every side/bottom zone to its remembered pixel size. Called on a topology change (a
    // zone opened/closed) so the OTHER columns keep their size and only the diagram absorbs the
    // freed/needed space — dockview would otherwise redistribute it proportionally. The bottom is
    // held too (its height is kept rigid everywhere except a user sash drag, see the ResizeObserver),
    // so a side open/close can never leave it at a different height. Guarded against recursion; only
    // touches a group actually off by >1px.
    const pinSideWidths = useCallback(() => {
        const api = apiRef.current;
        const diagramGroup = api?.getPanel('diagram')?.group;
        if (!api || !diagramGroup || pinningRef.current) return;
        pinningRef.current = true;
        try {
            for (const g of api.groups) {
                if (g.id === diagramGroup.id) continue;
                const zone = zoneOfGroup(g, diagramGroup);
                if (!zone) continue;
                const want = sizesRef.current[zone];
                if (!want) continue;
                const r = g.element.getBoundingClientRect();
                if (zone === 'bottom') {
                    if (Math.abs(Math.round(r.height) - want) > 1) g.api.setSize({ height: want });
                } else if (Math.abs(Math.round(r.width) - want) > 1) {
                    g.api.setSize({ width: want });
                }
            }
        } finally {
            pinningRef.current = false;
        }
    }, []);

    // Keep the 4-zone invariant after any drop/move: at most one group per zone, and the bottom
    // zone anchored under the diagram (not spanning the full width). Only fixes TOPOLOGY (merges
    // duplicate-zone groups, reparents a full-width bottom) — never touches sizes. Guarded against
    // recursing through its own moveTo-triggered layout changes.
    const reconcileZones = useCallback(() => {
        const api = apiRef.current;
        if (!api || reconcilingRef.current) return;
        const diagramGroup = api.getPanel('diagram')?.group;
        if (!diagramGroup) return;
        const seen = {};      // zone → canonical group
        const merges = [];    // panels to move into a canonical group
        let reparentBottom = null;
        for (const g of api.groups) {
            if (g.id === diagramGroup.id) continue;
            const zone = zoneOfGroup(g, diagramGroup);
            if (!zone) continue;
            if (seen[zone]) {
                for (const p of [...g.panels]) merges.push({ panel: p, into: seen[zone] });
            } else {
                seen[zone] = g;
                if (zone === 'bottom') {
                    const gr = g.element.getBoundingClientRect();
                    const dr = diagramGroup.element.getBoundingClientRect();
                    // Landed full-width (spans past the diagram column) → re-anchor under the diagram.
                    if (gr.width > dr.width + 8) reparentBottom = g;
                }
            }
        }
        if (!merges.length && !reparentBottom) return;
        reconcilingRef.current = true;
        try {
            for (const { panel, into } of merges) panel.api.moveTo({ group: into });
            if (reparentBottom) reparentBottom.api.moveTo({ group: diagramGroup, position: 'bottom' });
        } finally {
            reconcilingRef.current = false;
        }
    }, []);

    // Sizes are fully user-controlled (no auto-snap) — this just refreshes each open panel's
    // remembered zone (so reopening returns it where the user last had it) and persists.
    const syncZones = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;
        const diagramGroup = api.getPanel('diagram')?.group;
        if (diagramGroup) {
            const zones = { ...zonesRef.current };
            for (const panel of api.panels) {
                if (panel.id === 'diagram') continue;
                const z = zoneOfGroup(panel.group, diagramGroup);
                if (z) zones[panel.id] = z;
            }
            zonesRef.current = zones;
            saveZones(zones);
        }
        persist(api);
    }, [persist]);

    // Open a panel into its remembered zone: stack as a tab in that zone's group if one
    // exists, else create the zone group beside the diagram. No-op if already open.
    const ensurePanel = useCallback((id) => {
        const api = apiRef.current;
        if (!api || api.getPanel(id)) return;
        const meta = PANEL_META[id];
        const zone = zonesRef.current[id] || meta.zone;
        const diagram = api.getPanel('diagram');
        const diagramGroup = diagram?.group;
        const zoneGroup = findZoneGroup(api, zone, diagramGroup);
        if (zoneGroup) {
            // Zone already open → stack as a tab (no size change; the other zones stay put).
            api.addPanel({ id, component: id, title: meta.title, position: { referenceGroup: zoneGroup, direction: 'within' } });
        } else if (diagram) {
            // Create the zone as a fresh group beside/under the DIAGRAM (so left/right are full
            // height and bottom sits under the centre only), then size it to the per-zone width.
            const dock = dockRef.current;
            const size = zoneCreateSize(zone, dock, sizesRef.current);
            api.addPanel({
                id, component: id, title: meta.title,
                position: { referencePanel: 'diagram', direction: ZONE_DIRECTION[zone] },
                ...(zone === 'bottom' ? { initialHeight: size } : { initialWidth: size })
            });
            // Reassert the exact size one frame later (dockview may equalise the new split), pulling
            // the space from the diagram so the opposite column never changes width.
            const g = api.getPanel(id)?.group;
            if (g) requestAnimationFrame(() => g.api.setSize(zone === 'bottom' ? { height: size } : { width: size }));
        } else {
            api.addPanel({ id, component: id, title: meta.title });
        }
    }, []);

    // The default arrangement is EMPTY: just the (non-closable) diagram in the centre, no side
    // panels open. The app opens blank on first run and the user opens whatever they want; each
    // panel remembers its zone (see zone memory) so it reopens where it belongs. Also resets the
    // remembered zones to their defaults so a fresh open routes each panel to its default zone.
    const buildDefault = useCallback((api) => {
        api.clear();
        zonesRef.current = { ...DEFAULT_ZONES };
        saveZones(zonesRef.current);
        api.addPanel({ id: 'diagram', component: 'diagram', title: 'Sigil', tabComponent: 'plain' });
    }, []);

    const togglePanel = useCallback((id) => {
        const api = apiRef.current;
        if (!api) return;
        const p = api.getPanel(id);
        if (p) p.api.close();
        else ensurePanel(id);
    }, [ensurePanel]);

    const closePanel = useCallback((id) => {
        apiRef.current?.getPanel(id)?.api.close();
    }, []);

    // ---- VSCode-style zone show/hide toggles ---------------------------------------------
    // A zone can be hidden (its group removed) while remembering exactly which panels it held
    // and which tab was active, so the toggle — or a drop into that zone — brings it all back.

    // 'visible' = the zone has a group on screen; 'hidden' = it was toggled off (contents
    // remembered); 'empty' = neither (never used / cleared). Drives the toggle button state.
    const zoneState = useCallback((zone) => {
        const api = apiRef.current;
        const diagramGroup = api?.getPanel('diagram')?.group;
        if (api && findZoneGroup(api, zone, diagramGroup)) return 'visible';
        if (hiddenRef.current[zone]?.ids?.length) return 'hidden';
        return 'empty';
    }, []);

    // Hide a zone: remember its panels + active tab, then close them. The diagram absorbs the
    // freed space via the existing pin logic in onDidLayoutChange (a group-count change).
    const hideZone = useCallback((zone) => {
        const api = apiRef.current;
        if (!api) return;
        const diagramGroup = api.getPanel('diagram')?.group;
        const g = findZoneGroup(api, zone, diagramGroup);
        if (!g) return;
        hiddenRef.current[zone] = { ids: g.panels.map((p) => p.id), active: g.activePanel?.id };
        saveHidden(hiddenRef.current);
        restoringRef.current = true;
        try {
            g.panels.slice().forEach((p) => p.api.close());
        } finally {
            restoringRef.current = false;
        }
        setHiddenTick((n) => n + 1);
    }, []);

    // Show a zone: restore the remembered panels (they stack back into the recreated zone group
    // via ensurePanel) and reactivate the remembered tab. If nothing was remembered (empty zone),
    // open the zone's default panel instead — bottom has none, so it's a no-op there.
    const showZone = useCallback((zone) => {
        const api = apiRef.current;
        if (!api) return;
        const remembered = hiddenRef.current[zone];
        restoringRef.current = true;
        try {
            if (remembered?.ids?.length) {
                remembered.ids.forEach((id) => ensurePanel(id));
                if (remembered.active) api.getPanel(remembered.active)?.api.setActive();
                delete hiddenRef.current[zone];
                saveHidden(hiddenRef.current);
            } else {
                const def = ZONE_DEFAULT_PANEL[zone];
                if (def) ensurePanel(def);
            }
        } finally {
            restoringRef.current = false;
        }
        setHiddenTick((n) => n + 1);
    }, [ensurePanel]);

    const toggleZone = useCallback((zone) => {
        if (zoneState(zone) === 'visible') hideZone(zone);
        else showZone(zone);
    }, [zoneState, hideZone, showZone]);

    // When a hidden zone reappears (e.g. the user dragged a panel to its edge, creating a fresh
    // group there), fold the remembered panels back in so the zone returns with its old contents
    // PLUS whatever was just dropped. Called from onDidLayoutChange, after reconcile.
    const restoreRevealedZones = useCallback(() => {
        const api = apiRef.current;
        if (!api || restoringRef.current) return;
        const diagramGroup = api.getPanel('diagram')?.group;
        for (const zone of ['left', 'right', 'bottom']) {
            const remembered = hiddenRef.current[zone];
            if (!remembered?.ids?.length) continue;
            if (!findZoneGroup(api, zone, diagramGroup)) continue; // still hidden
            restoringRef.current = true;
            try {
                remembered.ids.forEach((id) => { if (!api.getPanel(id)) ensurePanel(id); });
            } finally {
                restoringRef.current = false;
            }
            delete hiddenRef.current[zone];
            saveHidden(hiddenRef.current);
            setHiddenTick((n) => n + 1);
        }
    }, [ensurePanel]);

    const openConnectAgent = useCallback(() => ensurePanel('connect-agent'), [ensurePanel]);

    // Reset the layout WITHOUT opening or closing anything: reset the cached zones/sizes to their
    // defaults and reflow ONLY the currently-open panels back into their default zone at the default
    // size. Panels that are closed stay closed — the cache reset just means they'll open in their
    // default spot next time. With nothing open, reset leaves the view empty (just the diagram).
    const resetLayout = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;
        // 1) Snapshot what's open and which tab is active in each zone (to restore focus after).
        const diagramGroup = api.getPanel('diagram')?.group;
        const openIds = api.panels.filter((p) => p.id !== 'diagram').map((p) => p.id);
        const activeIds = [];
        for (const zone of ['left', 'right', 'bottom']) {
            const active = findZoneGroup(api, zone, diagramGroup)?.activePanel?.id;
            if (active) activeIds.push(active);
        }
        // 2) Reset the caches to defaults and persist them (this fixes where CLOSED panels reopen and
        // what size every zone regenerates at).
        try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ }
        zonesRef.current = { ...DEFAULT_ZONES };
        sizesRef.current = { ...ZONE_DEFAULT_SIZE };
        hiddenRef.current = {};
        saveZones(zonesRef.current);
        saveSizes(sizesRef.current);
        saveHidden(hiddenRef.current);
        // 3) Rebuild empty (diagram only), then reopen ONLY the panels that were open — ensurePanel
        // reads the just-reset caches, so each lands in its default zone at its default size, and
        // panels sharing a zone stack as tabs.
        buildDefault(api);
        openIds.forEach((id) => ensurePanel(id));
        // 4) Restore the active tab of each rebuilt zone, then persist the new arrangement.
        activeIds.forEach((id) => api.getPanel(id)?.api.setActive());
        setHiddenTick((n) => n + 1);
        persist(api);
    }, [buildDefault, ensurePanel, persist]);

    const onReady = useCallback((event) => {
        const api = event.api;
        apiRef.current = api;
        zonesRef.current = loadZones();
        // Restore the saved arrangement; fall back to the default if absent/invalid or if it
        // somehow lacks the diagram. A restored layout might include a lingering resource-detail
        // panel (that one is data-driven), so drop it when nothing is selected.
        let restored = false;
        try {
            const raw = localStorage.getItem(LAYOUT_KEY);
            if (raw) { api.fromJSON(JSON.parse(raw)); restored = true; }
        } catch { restored = false; }
        if (!restored || !api.getPanel('diagram')) buildDefault(api);
        const rd = api.getPanel('resource-detail');
        if (rd && !selectedResourceRef.current) rd.api.close();
        // A layout saved before the rebrand carries the old "Diagram" tab title — retitle it.
        const dp = api.getPanel('diagram');
        if (dp && dp.title !== 'Sigil') dp.api.setTitle('Sigil');
        // A layout saved before the opencode-only change carries the old "opencode / Claude Code"
        // devtools tab title — bring any restored panel title in line with PANEL_META.
        for (const [id, meta] of Object.entries(PANEL_META)) {
            const p = api.getPanel(id);
            if (p && p.title !== meta.title) p.api.setTitle(meta.title);
        }

        // Rigid 4-zone (VSCode) model. There are only ever four places a panel can live: the
        // centre (the diagram — exclusive, locked, never a drop target and never draggable), and
        // the left / right / bottom zones. Each side zone is a single group; panels dropped into an
        // occupied zone STACK as tabs. The only two allowed drop gestures:
        //   1. Stack into an EXISTING side/bottom group (whole-group highlight) — kind tab /
        //      header_space, or content+center.
        //   2. Drop at a screen EDGE (left/right/bottom) to create that zone when it's empty.
        // Everything else (quarter splits, dropping onto the diagram, dragging the diagram, a top
        // edge, or a duplicate of an already-open zone) is prevented — so no arbitrary splits and
        // never two groups in one zone.
        api.onWillShowOverlay((e) => {
            const diagramGroup = api.getPanel('diagram')?.group;
            const data = e.getData?.();
            const draggingDiagram = !!data && (
                data.panelId === 'diagram' ||
                (data.panelId == null && data.groupId === diagramGroup?.id)
            );
            if (draggingDiagram) { e.preventDefault(); return; } // the diagram is locked to the centre

            if (e.kind === 'edge') {
                // Screen edges create an empty zone: the LEFT / RIGHT full-height columns, or the
                // BOTTOM strip. (A bottom edge lands full-width and is re-anchored under the diagram
                // by reconcileZones so it stays between the columns.) There is no top zone, and a
                // zone that already exists must be reached by stacking, not a second edge group.
                const zone = e.position === 'top' ? null : e.position; // 'left' | 'right' | 'bottom'
                if (!zone || findZoneGroup(api, zone, diagramGroup)) e.preventDefault();
                return;
            }

            const ontoDiagram = !!(e.group && diagramGroup && e.group.id === diagramGroup.id);
            if (ontoDiagram) {
                // Nothing stacks on the diagram. The one allowed diagram drop is creating the bottom
                // zone by dropping on its lower edge (when there's no bottom zone yet) — a
                // centre-width preview that lands exactly where it's shown.
                const makeBottom = e.kind === 'content' && e.position === 'bottom' &&
                    !findZoneGroup(api, 'bottom', diagramGroup);
                if (!makeBottom) e.preventDefault();
                return;
            }

            // Onto a side/bottom group: allow ONLY a whole-group stack (tab) — no sub-splits.
            const stacking = e.kind === 'tab' || e.kind === 'header_space' ||
                (e.kind === 'content' && e.position === 'center');
            if (!stacking) e.preventDefault();
        });

        // Size a left/right column the moment it's created by an edge drop. dockview gives the new
        // strip an equal 50% split; we snap it to the per-zone pixel width instead. onWillDrop fires
        // with kind 'edge' just before dockview moves the panel (onDidDrop does NOT fire for internal
        // drags carrying data), so we locate the landed group and size it one tick later. (The bottom
        // zone is created via a diagram-edge content drop, not here; pinSideWidths sizes it.)
        api.onWillDrop((e) => {
            if (e.kind !== 'edge') return;
            const data = e.getData?.();
            const pos = e.position;
            if (!data || e.defaultPrevented || data.panelId === 'diagram') return;
            if (pos !== 'left' && pos !== 'right') return;
            // A short delay, not rAF: dockview redistributes the splitview to equal sizes *after*
            // the next frame, so an rAF setSize gets overwritten (same timing quirk as elsewhere).
            setTimeout(() => {
                const panel = data.panelId
                    ? api.getPanel(data.panelId)
                    : api.groups.find((g) => g.id === data.groupId)?.panels[0];
                const group = panel?.group;
                const c = dockRef.current;
                if (!group || !c) return;
                group.api.setSize({ width: zoneCreateSize(pos, c, sizesRef.current) });
            }, 130);
        });

        setOpenIds(api.panels.map((p) => p.id));
        api.onDidLayoutChange(() => {
            setOpenIds(api.panels.map((p) => p.id));
            // If the user closed the resource-detail tab manually, clear the selection so the
            // diagram highlight goes away and a later click can reopen it.
            if (!api.getPanel('resource-detail') && selectedResourceRef.current) {
                setSelectedResource(null);
            }
            // Keep the 4-zone invariant (merge accidental duplicate-zone groups, re-anchor a
            // full-width bottom under the diagram). Guarded so it doesn't recurse on its own moves.
            reconcileZones();
            // If a hidden zone just reappeared (a panel was dropped into it), bring its remembered
            // contents back so it returns with its old panels plus whatever was dropped.
            restoreRevealedZones();
            const el = dockRef.current;
            // A window resize (container width changed) is handled by the ResizeObserver below —
            // skip sizing here so we don't capture dockview's transient proportional scaling.
            if (el && el.clientWidth !== lastContainerWRef.current) { syncZones(); return; }
            const count = api.groups.length;
            if (count === lastGroupCountRef.current) {
                // Same groups, stable width → a user sash drag (or a no-op). Remember the new sizes.
                captureZoneSizes();
            } else {
                // A zone opened or closed → re-pin the OTHER columns to their remembered width so
                // only the diagram gains/loses the space (VSCode-style), not the opposite column.
                pinSideWidths();
                lastGroupCountRef.current = count;
            }
            syncZones();
        });
        // Seed the stable container width + group count.
        lastContainerWRef.current = dockRef.current?.clientWidth || 0;
        lastGroupCountRef.current = api.groups.length;
        captureZoneSizes();
        syncZones();
    }, [buildDefault, syncZones, captureZoneSizes, reconcileZones, pinSideWidths, restoreRevealedZones]);

    // Data-driven: open/close the resource-detail panel following the diagram selection.
    useEffect(() => {
        const api = apiRef.current;
        if (!api) return;
        const existing = api.getPanel('resource-detail');
        if (selectedResource && !existing) ensurePanel('resource-detail');
        else if (!selectedResource && existing) existing.api.close();
    }, [selectedResource, ensurePanel]);

    // Keep the side columns at a FIXED pixel width when the whole window (dock container) is
    // resized, so ONLY the diagram grows/shrinks — like VSCode. dockview lays the grid out
    // proportionally, so a 360px column would otherwise scale to a third of a wide window. On every
    // container-width change we reassert each left/right column's remembered per-zone width (see
    // captureZoneSizes), so the columns hold their size and the diagram absorbs all the slack.
    // Restoring the exact remembered value (rather than scaling by a ratio) is order-independent:
    // it doesn't matter whether we run before or after dockview's own relayout. Manual sash drags
    // aren't container resizes, so a width the user set by hand is captured and simply reasserted.
    useEffect(() => {
        const el = dockRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => {
            const api = apiRef.current;
            const newW = el.clientWidth;
            if (!api || !newW || newW === lastContainerWRef.current) return;
            const diagramGroup = api.getPanel('diagram')?.group;
            if (!diagramGroup) { lastContainerWRef.current = newW; return; }
            // Defer past dockview's own proportional relayout (same one-frame timing quirk as the
            // drop handlers), then reassert each side column's remembered width.
            requestAnimationFrame(() => {
                for (const g of api.groups) {
                    if (g.id === diagramGroup.id) continue;
                    const zone = zoneOfGroup(g, diagramGroup);
                    if (!zone) continue;
                    const want = sizesRef.current[zone];
                    if (!want) continue;
                    const r = g.element.getBoundingClientRect();
                    // Hold each zone at its remembered pixel size so the diagram absorbs all slack —
                    // the bottom keeps its HEIGHT too, so a resize never leaves it drifted (which a
                    // later side toggle would otherwise snap back, reading as the bottom "growing").
                    if (zone === 'bottom') {
                        if (Math.abs(Math.round(r.height) - want) > 1) g.api.setSize({ height: want });
                    } else if (Math.abs(Math.round(r.width) - want) > 1) {
                        g.api.setSize({ width: want });
                    }
                }
                // Mark this width as the new stable baseline so later sash drags capture again.
                lastContainerWRef.current = el.clientWidth;
            });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // The dropdown shows only the human name (fall back to a short id for unnamed
    // sigils). Dates / full id / rename live in the Details panel.
    function chatLabel(c) {
        return c.name || `Sigil ${c.chatId.slice(0, 8)}`;
    }

    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    const selectedChat = chats.find((c) => c.chatId === chatId) || null;

    // In dev the token is the fixed env one (always known). Otherwise use the freshly generated
    // token if we have one; the secret of an existing token is never returned to the UI, so a
    // ready-to-paste command is only possible right after generating it.
    const tokenForCmd = dev ? devToken : (newToken || TOKEN_PLACEHOLDER);
    // In dev, point the MCP at the local server; in prod it defaults to the hosted deployment.
    const urlEnv = dev && visualizerUrl ? ` SIGILUM_URL=${visualizerUrl}` : '';
    // opencode in production: one command that installs opencode if needed and writes the MCP entry
    // into ~/.config/opencode/opencode.json (idempotent — re-running only refreshes the token). The
    // token goes via env var (same name the MCP reads), so it's not stored as a CLI flag.
    // In dev we can't use that helper: it owns the single `sigilum` key, so it
    // would clobber a user's hosted entry. Show a manual `-local` entry instead, which coexists.
    const opencodeDevSnippet = `"sigilum-local": {
  "type": "local",
  "command": ["npx", "-y", "sigilum-mcp@latest"],
  "enabled": true,
  "environment": {
    "SIGILUM_TOKEN": "${tokenForCmd}",
    "SIGILUM_URL": "${visualizerUrl}"
  }
}`;
    const opencodeAddCommand = dev
        ? opencodeDevSnippet
        : `SIGILUM_TOKEN=${tokenForCmd}${urlEnv} npx -y @apozo/sigilum-setup`;
    const addCommand = opencodeAddCommand;

    function copy(text, key) {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(key);
        setTimeout(() => setCopied((k) => (k === key ? '' : k)), 1500);
    }

    // Everything the dockview panels read. Recreated per render (cheap for this UI); panels
    // pull only what they need via useDeployed().
    const ctx = {
        svg, renderError, resources, selectedResource, setSelectedResource,
        chatId, chatsCount: chats.length,
        explanation, explaining, generateExplanation,
        selectedChat, deployed,
        editingName, setEditingName, renameValue, setRenameValue,
        renameChat, cancelRename, startRename, formatDate, copy, copied,
        confirmDelete, setConfirmDelete, deleteChat, deleting,
        dev, devToken, visualizerUrl, tokens, tokenError, newToken,
        TOKEN_LIMIT, TOKEN_PLACEHOLDER,
        generateToken, revokeToken, confirmRevoke, setConfirmRevoke,
        opencodeDevSnippet, addCommand,
        openConnectAgent
    };

    const isOpen = (id) => openIds.includes(id);

    return (
        <DeployedContext.Provider value={ctx}>
            <div className="deployed-state">
                <div className="deployed-toolbar">
                    <div className="tbar-group project-form">
                        <label htmlFor="viz-chat">Sigil</label>
                        <select
                            id="viz-chat"
                            value={chatId}
                            onChange={(e) => setChatId(e.target.value)}
                        >
                            <option value="">{chats.length ? 'Select a sigil…' : 'No sigils yet'}</option>
                            {chats.map((c) => (
                                <option key={c.chatId} value={c.chatId}>
                                    {`${c.deployed ? '● ' : '○ '}${chatLabel(c)}`}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={loadChats}
                            title="Refresh sigils"
                            aria-label="Refresh sigils"
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                                strokeLinejoin="round" aria-hidden="true">
                                <polyline points="23 4 23 10 17 10" />
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                        </button>
                    </div>
                    {chatId && (
                        <span
                            className={`badge ${deployed ? 'badge-deployed' : 'badge-preview'}`}
                            title={deployed
                                ? 'Live — these resources are deployed in AWS'
                                : 'Design — a sketch; nothing is deployed to AWS yet'}
                            aria-label={`Sigil mode: ${deployed ? 'Live, deployed to AWS' : 'Design, not deployed'}`}
                        >
                            {deployed ? 'Live' : 'Design'}
                        </span>
                    )}
                    {chatId && (
                        <div className="tbar-group">
                            <button
                                type="button"
                                className="tbar-btn"
                                onClick={() => togglePanel('details')}
                                aria-expanded={isOpen('details')}
                                title="Sigil details — rename, mode and delete"
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="12" cy="12" r="9" />
                                    <line x1="12" y1="11" x2="12" y2="16" />
                                    <line x1="12" y1="8" x2="12.01" y2="8" />
                                </svg>
                                Details
                            </button>
                            <button
                                type="button"
                                className="tbar-btn explain-btn"
                                onClick={() => togglePanel('explanation')}
                                aria-expanded={isOpen('explanation')}
                                title="Explain this sigil component by component"
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H2z" />
                                    <path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H22z" />
                                </svg>
                                Explain
                                {explanation?.outdated && <span className="explain-dot" aria-hidden="true" />}
                            </button>
                        </div>
                    )}
                    <div className="tbar-spacer" />
                    <div className="tbar-group" role="group" aria-label="Disposición de paneles">
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={resetLayout}
                            title="Restablecer la disposición de los paneles"
                            aria-label="Restablecer la disposición de los paneles"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="1 4 1 10 7 10" />
                                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                            </svg>
                        </button>
                        <div className="zone-toggles" role="group" aria-label="Ocultar o mostrar zonas">
                            <button
                                type="button"
                                className="zone-toggle icon-btn"
                                onClick={() => toggleZone('left')}
                                aria-pressed={zoneState('left') === 'visible'}
                                title="Ocultar o mostrar la barra izquierda"
                                aria-label="Ocultar o mostrar la barra izquierda"
                            >
                                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                                    <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                                    <rect x="3" y="4" width="6" height="16" rx="1.5" fill="currentColor" />
                                </svg>
                            </button>
                            <button
                                type="button"
                                className="zone-toggle icon-btn"
                                onClick={() => toggleZone('bottom')}
                                aria-pressed={zoneState('bottom') === 'visible'}
                                disabled={zoneState('bottom') === 'empty'}
                                title="Ocultar o mostrar el panel inferior"
                                aria-label="Ocultar o mostrar el panel inferior"
                            >
                                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                                    <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                                    <rect x="3" y="14" width="18" height="6" rx="1.5" fill="currentColor" />
                                </svg>
                            </button>
                            <button
                                type="button"
                                className="zone-toggle icon-btn"
                                onClick={() => toggleZone('right')}
                                aria-pressed={zoneState('right') === 'visible'}
                                title="Ocultar o mostrar la barra derecha"
                                aria-label="Ocultar o mostrar la barra derecha"
                            >
                                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                                    <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                                    <rect x="15" y="4" width="6" height="16" rx="1.5" fill="currentColor" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    <span className="tbar-sep" aria-hidden="true" />
                    <div className="tbar-group">
                        <button
                            type="button"
                            className="tbar-btn tbar-opencode"
                            onClick={() => togglePanel('devtools')}
                            aria-expanded={isOpen('devtools')}
                            title="Show the opencode panel"
                        >
                            <img className="tbar-opencode-logo" src="/opencode.png" alt="opencode" />
                        </button>
                        <button
                            type="button"
                            className="tbar-btn"
                            onClick={() => togglePanel('guide')}
                            aria-expanded={isOpen('guide')}
                            title="Show the Sigilum guide"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="9" />
                                <polygon points="15.6 8.4 13.6 13.6 8.4 15.6 10.4 10.4 15.6 8.4" />
                            </svg>
                            Guide
                        </button>
                        <button
                            type="button"
                            className="tbar-btn"
                            onClick={() => togglePanel('connect-agent')}
                            aria-expanded={isOpen('connect-agent')}
                            title="Connect your agent via the MCP server"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M9 17H7A5 5 0 0 1 7 7h2" />
                                <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
                                <line x1="8" y1="12" x2="16" y2="12" />
                            </svg>
                            Connect agent
                        </button>
                    </div>
                </div>

                <div className="viz-dock" ref={dockRef}>
                    <DockviewReact
                        components={PANEL_COMPONENTS}
                        tabComponents={TAB_COMPONENTS}
                        theme={themeAbyss}
                        disableFloatingGroups
                        // Root-edge drop zones. The default 10px activation band made the bottom
                        // edge nearly impossible to hit; widen it so "drag towards the bottom"
                        // naturally shows the full-width bottom-strip preview (25% tall).
                        dndEdges={DND_EDGES}
                        dropOverlayModel={DROP_OVERLAY_MODEL}
                        onReady={onReady}
                    />
                </div>
            </div>
        </DeployedContext.Provider>
    );
}
