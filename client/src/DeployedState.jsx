import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { DockviewReact, themeAbyss } from 'dockview-react';
import { createSocket } from './ws.js';
import { DeployedContext } from './DeployedContext.js';
import { isExternalResource } from './externalResource.js';
import SigilSelect from './SigilSelect.jsx';
import UserMenu from './UserMenu.jsx';
import Logo from './Logo.jsx';
import DiagramPanel from './panels/DiagramPanel.jsx';
import ResourceDetailPanel from './panels/ResourceDetailPanel.jsx';
import CodePanel from './panels/CodePanel.jsx';
import AskPanel from './panels/AskPanel.jsx';
import SigilOptionsPanel from './panels/SigilOptionsPanel.jsx';
import DevToolsPanel from './panels/DevToolsPanel.jsx';
import ExportModal from './ExportModal.jsx';
import ConnectAgentModal from './ConnectAgentModal.jsx';
import ShareModal from './ShareModal.jsx';

// dockview panel registry (id → component). The layout is a rigid VSCode-like model: the
// diagram is the fixed, locked centre anchor (like the editor) and every other panel lives in
// one of exactly three zones — left / right (full-height columns) or bottom (a strip under the
// diagram, between the columns). At most ONE group per zone; panels opened into the same zone
// stack as tabs. Side columns keep a fixed pixel width (persisted per zone); only the diagram
// grows when the window widens.
const PANEL_COMPONENTS = {
    diagram: DiagramPanel,
    'resource-detail': ResourceDetailPanel,
    code: CodePanel,
    ask: AskPanel,
    settings: SigilOptionsPanel,
    devtools: DevToolsPanel
};
// Each panel's DEFAULT zone. The user can move a panel to another zone; that choice is
// remembered (see zone memory below) and used when the panel is reopened.
const PANEL_META = {
    ask: { title: 'Ask', zone: 'right' },
    'resource-detail': { title: 'Resource', zone: 'right' },
    code: { title: 'Code', zone: 'right' },
    settings: { title: 'Options', zone: 'right' },
    devtools: { title: 'opencode', zone: 'left' }
};
// Zone → the dockview direction used to create that zone's group next to the diagram.
const ZONE_DIRECTION = { left: 'left', right: 'right', bottom: 'below' };
// The panel a zone toggle opens when its zone is empty AND nothing was remembered (VSCode
// opens the default view when you toggle an empty sidebar on). Bottom has no default → its
// toggle stays disabled until something lives there.
const ZONE_DEFAULT_PANEL = { left: 'devtools', right: 'ask', bottom: null };

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

// Every service opens as a normal, named detail tab (there is no special "preview" tab). Each tab
// is one instance of the 'resource-detail' component under a unique id in this namespace, bound to
// a resource via its params (retargeted in place on a plain click, so the id stays stable while the
// resource it shows changes). The logical zone key below is shared by all of them so a moved
// column is remembered for tabs opened later.
const RES_PREFIX = 'resource-tab~';
const RES_ZONE_KEY = 'resource-detail';
const isResourceTabId = (id) => typeof id === 'string' && id.startsWith(RES_PREFIX);
const newResourceTabId = () =>
    RES_PREFIX + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Short, human tab title for a resource detail tab: the resource's own name if it has one, else its
// service type, else its id — truncated so the tab stays compact.
function resourceTabTitle(resource) {
    const t = (resource?.name || resource?.type || resource?.id || 'Resource').toString();
    return t.length > 24 ? t.slice(0, 23) + '…' : t;
}

// The resource id a detail tab is bound to (null for any non-resource panel), read from its params.
// Drives which node the diagram highlights when a resource tab is active.
function resourceIdOfPanel(panel) {
    return panel && isResourceTabId(panel.id) ? (panel.params?.resourceId ?? null) : null;
}

// Bump the suffixes when panel ids / defaults change so stale saved state is ignored.
// (v8 = added the Code window panel; v7 = rigid 4-zone VSCode model.)
const LAYOUT_KEY = 'viz-dock-layout-v8';
const ZONES_KEY = 'viz-dock-zones-v8';
const SIZES_KEY = 'viz-dock-sizes-v8';
const HIDDEN_KEY = 'viz-dock-hidden-v8';
// The sigil (chat) the user last had selected, so it reopens on reload / revisit.
const CHAT_KEY = 'viz-current-chat';
// Set the first time the first-run guide auto-opens "Connect agent", so it only ever happens once.
const ONBOARDED_KEY = 'viz-onboarded';

// Per-sigil display preferences (Sigil Options → "Diagram display"): purely cosmetic, frontend-
// only — never sent to the backend, never affects what the agent generates. Defaults match
// today's actual look (everything shown, no animation) so every existing sigil is pixel-identical
// until the user opens Options and changes something.
const VIZ_PREFS_KEY = 'viz-diagram-prefs';
// lineThickness is a stroke width in px; animationSpeed is a flow-cycle duration in seconds. Both
// are numbers now (driven by sliders) — defaults reproduce D2's fixed stroke-width:2 and the
// original 0.9s flow, so every existing sigil stays pixel-identical until the user changes them.
const DEFAULT_VIZ_PREFS = {
    showConnectionLabels: true,
    showStepNumbers: true, // prefix each connection label with its workflow step number (e.g. "2. ...")
    showServiceLabels: true,
    showGroupBoxes: true,
    showExternalActor: true,
    lineThickness: 2,
    dashedLines: false,
    animateArrows: false,
    animationSpeed: 0.9
};
// Legacy coercion: earlier builds stored these two as string enums. Map them to the equivalent
// numbers so a sigil saved before the sliders shipped loads (and renders) identically.
const LEGACY_THICKNESS = { thin: 1, normal: 2, thick: 4 };
const LEGACY_SPEED = { slow: 1.8, normal: 0.9, fast: 0.45 };
// Coerce one merged prefs object so downstream (sliders, Diagram, export) always sees numbers.
function normalizeVizPrefs(prefs) {
    const out = { ...prefs };
    if (typeof out.lineThickness === 'string') out.lineThickness = LEGACY_THICKNESS[out.lineThickness] ?? 2;
    if (typeof out.animationSpeed === 'string') out.animationSpeed = LEGACY_SPEED[out.animationSpeed] ?? 0.9;
    return out;
}
function loadVizPrefs() {
    try {
        const saved = JSON.parse(localStorage.getItem(VIZ_PREFS_KEY) || '{}');
        return (saved && typeof saved === 'object') ? saved : {};
    } catch {
        return {};
    }
}
function saveVizPrefs(prefs) {
    try { localStorage.setItem(VIZ_PREFS_KEY, JSON.stringify(prefs)); } catch { /* quota */ }
}

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

// Drop panels whose component no longer exists from a SAVED layout, before handing it to
// dockview. This matters whenever a panel is retired (the Guide became a modal; "connect-agent"
// before it): dockview THROWS while deserializing a panel whose contentComponent isn't
// registered, which would discard the user's whole arrangement — every still-valid panel with
// it — and log a deserialize error. Pruning first keeps everything that is still valid.
// Mutates and returns `layout`; returns null if nothing usable is left.
function pruneRetiredPanels(layout) {
    const panels = layout?.panels;
    if (!panels || typeof panels !== 'object') return layout;

    const dead = new Set();
    for (const [id, panel] of Object.entries(panels)) {
        // Resource tabs live under per-instance ids but render the registered 'resource-detail'
        // component, so keying off contentComponent covers them for free.
        if (!PANEL_COMPONENTS[panel?.contentComponent]) {
            dead.add(id);
            delete panels[id];
        }
    }
    if (!dead.size) return layout;

    // Prune the dead views out of the grid, collapsing any leaf/branch left empty.
    const walk = (node) => {
        if (!node) return null;
        if (node.type === 'leaf') {
            const views = (node.data?.views || []).filter((v) => !dead.has(v));
            if (!views.length) return null;
            node.data.views = views;
            if (dead.has(node.data.activeView)) node.data.activeView = views[0];
            return node;
        }
        if (node.type === 'branch') {
            const kids = (node.data || []).map(walk).filter(Boolean);
            if (!kids.length) return null;
            node.data = kids;
            return node;
        }
        return node;
    };

    layout.grid.root = walk(layout.grid.root);
    return layout.grid.root ? layout : null;
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

// The Sigils view — the whole screen: the single top bar (brand · layout toggles · sigil
// selector · panel buttons · profile) plus the dockview workspace. Subscribes to one chat on
// the visualizer socket and renders a live diagram of what is actually deployed in AWS
// (pushed from the user's agent via the MCP tool). Each chat has its own isolated diagram.
// The diagram + all side panels live in a VSCode-like dockview layout the user can rearrange
// into the four zones (drag to stack / dock at an edge / resize); the arrangement and
// per-zone sizes are persisted to localStorage.
// A PUBLIC share link renders this very component, so the shared page keeps the real workspace —
// docking, panels, zoom, export — instead of a thin copy that would drift from it. `share` is
// `{ token }` there and null for the owner; everything below keys off it:
//   · the detail fetch goes to /api/share/<token> and the socket carries ?share=<token>;
//   · the socket subscribes to whatever sigil the token names, which is why the public payload
//     never has to reveal a chat id (the token itself stands in as the local key);
//   · the sigil selector, Connect agent, Options and the profile menu are not rendered at all —
//     none of them has anything to act on without an account;
//   · Ask shows an invitation to sign up (see AskPanel).
export default function DeployedState({ user, onUserChange, onOpenAdmin, share = null }) {
    const [connected, setConnected] = useState(false);
    const [chats, setChats] = useState([]);
    // Whether /api/chats has answered at least once. `chats` starts empty, so without this the
    // first-run guide would briefly think an established user has no sigils and auto-open on them.
    const [chatsLoaded, setChatsLoaded] = useState(false);
    // In share mode the token doubles as the local sigil key: it is truthy so every "a sigil is
    // selected" effect runs, and it is never sent anywhere that expects a chat id.
    const [chatId, setChatId] = useState(() => {
        if (share) return share.token;
        try { return localStorage.getItem(CHAT_KEY) || ''; } catch { return ''; }
    });
    // The sigil's name on a share page. The owner reads it off the sigil list; a visitor has no
    // list, so it comes from the public payload.
    const [sharedName, setSharedName] = useState('');
    const [svg, setSvg] = useState('');
    // The step-numbered variant of the same diagram, rendered server-side from the same D2 and
    // sharing its exact geometry — see displaySvg below. `hasSteps` is false when the diagram has no
    // workflow step numbers (then the Step-numbers toggle is disabled).
    const [svgActionSteps, setSvgActionSteps] = useState('');
    const [hasSteps, setHasSteps] = useState(false);
    const [renderError, setRenderError] = useState(null);
    // Per-sigil display preferences (see VIZ_PREFS_KEY above), keyed by chatId. Loaded once;
    // `setVizPref` below both updates this and persists it.
    const [allVizPrefs, setAllVizPrefs] = useState(loadVizPrefs);
    // "Connect agent" pop-up (opened from the toolbar/Guide CTA — it lives in the profile menu
    // too). Self-contained: it fetches its own token data.
    const [connectOpen, setConnectOpen] = useState(false);
    // Token presence, for the first-run guide. The modal fetches /api/tokens for its own purposes;
    // we need the count here to know whether this account can talk to the MCP at all.
    const [tokenInfo, setTokenInfo] = useState({ loading: true, dev: false, count: 0 });
    // "Export sigil" pop-up (PNG / JPG / SVG).
    const [exportOpen, setExportOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [copied, setCopied] = useState('');
    const [renameValue, setRenameValue] = useState('');
    const [editingName, setEditingName] = useState(false);
    // Surfaced when a rename is refused because the name is already taken (names are unique).
    const [renameError, setRenameError] = useState('');
    // Inline two-step confirm for the destructive "Delete diagram" action in the Details panel.
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // Live resource inventory for the selected chat (powers per-service tooltips + the detail
    // panel), and the resource the user clicked in the diagram.
    const [resources, setResources] = useState([]);
    // The resource of the currently active detail tab — the node the diagram highlights, and the
    // "current resource" the Code window follows. Kept in sync from dockview's active-panel changes
    // and set directly when a click retargets/creates a tab (an already-active tab fires no event).
    const [activeResourceId, setActiveResourceId] = useState(null);
    // The Code window's target: { resourceId, fileName } or null. Set by "View code" in the
    // resource detail panel; drives opening/closing the dedicated `code` panel.
    const [codeView, setCodeView] = useState(null);
    // Mode of the selected diagram: true = "Live" (deployed to AWS), false = "Design" (a sketch).
    const [deployed, setDeployed] = useState(false);
    // Bumped on every diagram broadcast to force a resource/mode refetch even when the regenerated
    // SVG is byte-identical (e.g. a teardown flips flags but keeps the same nodes → same D2).
    const [syncNonce, setSyncNonce] = useState(0);
    const socketRef = useRef(null);

    // dockview plumbing: the layout api, a debounce timer for persistence, the set of
    // currently-open panel ids (drives the toolbar toggles' aria-expanded), and a ref
    // mirror of the current selection (read inside the layout-change callback).
    const apiRef = useRef(null);
    const dockRef = useRef(null);           // the .viz-dock container (for width/animation)
    const saveTimer = useRef(null);
    const codeViewRef = useRef(null);       // mirror of codeView, read inside layout-change callback
    const lastResourceTabIdRef = useRef(null); // id of the last resource tab that was active (the tab a plain click retargets)
    const lastActiveResourceRef = useRef(null); // last active resource id (to close Code on a real change)
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
        // Close the Code window when the active resource moves to a DIFFERENT one (or clears) — but
        // not on a mere data refresh that keeps the same id (a push updates the object in place).
        if (activeResourceId !== lastActiveResourceRef.current) {
            lastActiveResourceRef.current = activeResourceId;
            setCodeView(null);
        }
    }, [activeResourceId]);

    useEffect(() => {
        codeViewRef.current = codeView;
    }, [codeView]);

    useEffect(() => {
        const socket = createSocket(handleMessage, setConnected,
            share ? `/ws-visualizer?share=${encodeURIComponent(share.token)}` : '/ws-visualizer');
        socketRef.current = socket;
        if (!share) {
            loadChats();
            loadTokens();
        }
        return () => socket.close();
    }, []);

    // (Re)subscribe whenever the active chat changes or we (re)connect. With no chat
    // selected we show nothing — the diagram only loads once the user picks a chat.
    useEffect(() => {
        setSvg('');
        setRenderError(null);
        setActiveResourceId(null);
        if (connected && chatId) {
            socketRef.current?.send(share ? { type: 'subscribe' } : { type: 'subscribe', chatId });
        }
    }, [connected, chatId]);

    // Keep the resource inventory in sync with the selected chat: reload on chat change and
    // whenever a new diagram arrives (a push changed the deployed state). Reconcile the open
    // detail panel against the fresh data (update it, or close it if the resource is gone).
    useEffect(() => {
        if (!chatId) {
            setResources([]);
            setDeployed(false);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(share
                    ? `/api/share/${encodeURIComponent(share.token)}`
                    : `/api/chats/${encodeURIComponent(chatId)}`);
                const data = await res.json();
                if (cancelled) return;
                const list = Array.isArray(data.resources) ? data.resources : [];
                setResources(list);
                if (share) setSharedName(typeof data.name === 'string' ? data.name : '');
                setDeployed(data.deployed === true);
                // Drop any resource tab whose resource is no longer in the sigil.
                const api = apiRef.current;
                if (api) {
                    for (const p of [...api.panels]) {
                        if (!isResourceTabId(p.id)) continue;
                        const rid = p.params?.resourceId;
                        if (rid && !list.some((r) => r.id === rid)) p.api.close();
                    }
                }
            } catch {
                if (!cancelled) setResources([]);
            }
        })();
        return () => { cancelled = true; };
    }, [chatId, svg, syncNonce]);

    // Persist the selected sigil so a reload / revisit reopens it.
    useEffect(() => {
        // Not on a share page: the "chat id" there is a share token, and remembering it would send
        // the owner back to someone's public link the next time they open Sigilum.
        if (share) return;
        try {
            if (chatId) localStorage.setItem(CHAT_KEY, chatId);
            else localStorage.removeItem(CHAT_KEY);
        } catch { /* quota / disabled storage */ }
    }, [chatId, share]);

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
                setSvgActionSteps(message.svgActionSteps || '');
                setHasSteps(Boolean(message.hasSteps));
                setRenderError(message.renderError || null);
                // Force a resource/mode refetch even if the SVG didn't change (e.g. a teardown keeps
                // the same nodes but flips every resource to undeployed and the sigil to Design).
                setSyncNonce((n) => n + 1);
                // A push may have created/updated a chat — refresh the list. Never on a share page:
                // there is no list there, and its reconciliation would drop the token that stands in
                // for the chat id, blanking the whole view.
                if (!share) loadChats();
                break;
            case 'error':
                setRenderError(message.message);
                break;
            default:
                break;
        }
    }

    // Local dev has no generated tokens at all — it returns `dev: true` plus a fixed token, and
    // POST /api/tokens is a hard 403. So dev counts as "already has a token": steps 2 and 3 still
    // apply there.
    async function loadTokens() {
        try {
            const res = await fetch('/api/tokens');
            const data = await res.json();
            setTokenInfo({
                loading: false,
                dev: Boolean(data.dev),
                count: Array.isArray(data.tokens) ? data.tokens.length : 0
            });
        } catch {
            // Treat an unreachable endpoint as "has a token" so a transient failure never puts an
            // established user through onboarding.
            setTokenInfo({ loading: false, dev: false, count: 1 });
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
        } finally {
            setChatsLoaded(true);
        }
    }

    // Override the auto-assigned session name for the selected chat.
    async function renameChat() {
        const name = renameValue.trim();
        if (!chatId || !name) return;
        setRenameError('');
        try {
            const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (!res.ok) {
                // 409 = duplicate name; surface the server's message and keep editing.
                let message = 'Could not rename the diagram. Try again.';
                try { const data = await res.json(); if (data?.error) message = data.error; } catch { /* keep default */ }
                setRenameError(message);
                return;
            }
            setEditingName(false);
            loadChats();
        } catch {
            setRenameError('Could not rename the diagram. Try again.');
        }
    }

    function startRename() {
        setRenameValue(selectedChat?.name || '');
        setRenameError('');
        setEditingName(true);
    }

    // Permanently delete the selected diagram, then deselect it (the subscribe/load effects
    // clear svg/resources for an empty chatId) and refresh the selector. Close the
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
        closePanel('settings');
        closePanel('ask');
        setChatId('');
        loadChats();
    }

    function cancelRename() {
        setRenameValue(selectedChat?.name || '');
        setRenameError('');
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
                if (!z) continue;
                // Resource tabs share one logical zone key so a moved column is remembered for new
                // tabs; their per-instance ids never accumulate in the map.
                zones[isResourceTabId(panel.id) ? RES_ZONE_KEY : panel.id] = z;
            }
            zonesRef.current = zones;
            saveZones(zones);
        }
        persist(api);
    }, [persist]);

    // Add a panel into `zone`: stack as a tab in that zone's existing group, else create the zone
    // group beside/under the diagram at its remembered size (reasserted one frame later, since
    // dockview equalises the fresh split, so only the diagram gives up the space). Shared by
    // ensurePanel (single-instance panels) and createResourceTab (per-resource detail tabs).
    const addIntoZone = useCallback(({ id, component, title, params, zone }) => {
        const api = apiRef.current;
        if (!api) return;
        const diagram = api.getPanel('diagram');
        const diagramGroup = diagram?.group;
        const zoneGroup = findZoneGroup(api, zone, diagramGroup);
        if (zoneGroup) {
            // Zone already open → stack as a tab (no size change; the other zones stay put).
            api.addPanel({ id, component, title, params, position: { referenceGroup: zoneGroup, direction: 'within' } });
        } else if (diagram) {
            // Create the zone as a fresh group beside/under the DIAGRAM (so left/right are full
            // height and bottom sits under the centre only), then size it to the per-zone width.
            const dock = dockRef.current;
            const size = zoneCreateSize(zone, dock, sizesRef.current);
            api.addPanel({
                id, component, title, params,
                position: { referencePanel: 'diagram', direction: ZONE_DIRECTION[zone] },
                ...(zone === 'bottom' ? { initialHeight: size } : { initialWidth: size })
            });
            // Reassert the exact size one frame later (dockview may equalise the new split), pulling
            // the space from the diagram so the opposite column never changes width.
            const g = api.getPanel(id)?.group;
            if (g) requestAnimationFrame(() => g.api.setSize(zone === 'bottom' ? { height: size } : { width: size }));
        } else {
            api.addPanel({ id, component, title, params });
        }
    }, []);

    // Open a single-instance panel into its remembered zone. No-op if already open.
    const ensurePanel = useCallback((id) => {
        const api = apiRef.current;
        if (!api || api.getPanel(id)) return;
        const meta = PANEL_META[id];
        const zone = zonesRef.current[id] || meta.zone;
        addIntoZone({ id, component: id, title: meta.title, zone });
    }, [addIntoZone]);

    // Open a NEW resource detail tab, bound to `resource` and stacked into the (right by default)
    // resource column. Each tab gets a fresh unique id so several services stay open at once.
    const createResourceTab = useCallback((resource) => {
        const api = apiRef.current;
        if (!api || !resource?.id) return;
        const id = newResourceTabId();
        const zone = zonesRef.current[RES_ZONE_KEY] || PANEL_META['resource-detail'].zone;
        addIntoZone({ id, component: 'resource-detail', title: resourceTabTitle(resource), params: { resourceId: resource.id }, zone });
        // A freshly-added tab is active, but if it merely stacked onto the existing column dockview
        // may not fire an active-panel change — set the highlight directly.
        lastResourceTabIdRef.current = id;
        setActiveResourceId(resource.id);
    }, [addIntoZone]);

    // Point an existing resource tab at a different resource (retitle + rebind its params). Used by
    // a plain click so the last-used tab is reused in place rather than piling up new tabs.
    const retargetResourceTab = useCallback((panel, resource) => {
        panel.setTitle(resourceTabTitle(resource));
        panel.update({ params: { ...(panel.params || {}), resourceId: resource.id } });
        panel.api.setActive();
        lastResourceTabIdRef.current = panel.id;
        setActiveResourceId(resource.id); // an already-active tab fires no change event
    }, []);

    // A service node click from the diagram:
    //  • Shift-click, OR no resource tab open yet → open a NEW tab.
    //  • Plain click with tabs already open → reuse the last-selected resource tab (the active one
    //    if it's a resource tab, else the most-recently active, else any open one).
    const selectResource = useCallback((resource, newTab) => {
        const api = apiRef.current;
        if (!api || !resource?.id) return;
        const openTabs = api.panels.filter((p) => isResourceTabId(p.id));
        if (newTab || openTabs.length === 0) { createResourceTab(resource); return; }
        const active = api.activePanel;
        const target =
            (active && isResourceTabId(active.id) && active) ||
            (lastResourceTabIdRef.current && openTabs.find((p) => p.id === lastResourceTabIdRef.current)) ||
            openTabs[openTabs.length - 1];
        retargetResourceTab(target, resource);
    }, [createResourceTab, retargetResourceTab]);

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

    const openConnectAgent = useCallback(() => setConnectOpen(true), []);

    // "View code" on a resource → point the Code window at that file (an effect opens the panel).
    const openCode = useCallback((resource, file) => {
        if (!resource?.id || !file?.name) return;
        setCodeView({ resourceId: resource.id, fileName: file.name });
    }, []);

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
        // 3) Close ONLY the side panels (never the diagram) so the diagram stays mounted — clearing
        // the whole layout would remount it and re-render the SVG (a visible flash/jump on reset).
        api.panels.filter((p) => p.id !== 'diagram').forEach((p) => p.api.close());
        // 4) Reopen ONLY the panels that were open — ensurePanel reads the just-reset caches, so each
        // lands in its default zone at its default size, and panels sharing a zone stack as tabs.
        openIds.forEach((id) => ensurePanel(id));
        // 5) Restore the active tab of each rebuilt zone, then persist the new arrangement.
        activeIds.forEach((id) => api.getPanel(id)?.api.setActive());
        setHiddenTick((n) => n + 1);
        persist(api);
    }, [ensurePanel, persist]);

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
            const layout = raw ? pruneRetiredPanels(JSON.parse(raw)) : null;
            if (layout) { api.fromJSON(layout); restored = true; }
        } catch { restored = false; }
        if (!restored || !api.getPanel('diagram')) buildDefault(api);
        // A layout saved before a panel was removed (e.g. the old "connect-agent" panel, now a
        // modal) may carry an id with no registered component — close any such orphan so the
        // restore doesn't render a blank/broken pane.
        for (const p of [...api.panels]) {
            // Resource tabs render the 'resource-detail' component under a per-instance id, so they
            // aren't keyed in PANEL_COMPONENTS by their own id — keep them on restore (they rebind
            // to their resource from params, or show an empty state if it's gone).
            if (!PANEL_COMPONENTS[p.id] && !isResourceTabId(p.id)) p.api.close();
        }
        // The Code window is transient (no target until "View code" is clicked) — close any
        // restored instance so a stale layout doesn't reopen an empty pane.
        const cp = api.getPanel('code');
        if (cp && !codeViewRef.current) cp.api.close();
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
            // When no resource tab is open any more, drop the highlight so a later click starts fresh
            // (setState no-ops when it's already null).
            if (!api.panels.some((p) => isResourceTabId(p.id))) setActiveResourceId(null);
            // Closing the Code tab clears its target so it can be reopened cleanly.
            if (!api.getPanel('code') && codeViewRef.current) {
                setCodeView(null);
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
        // Keep the diagram highlight on whichever resource tab is active, and remember it as the tab
        // a later plain click will reuse. Activating a non-resource panel leaves both as-is (the
        // last resource stays highlighted and reusable).
        api.onDidActivePanelChange((e) => {
            const rid = resourceIdOfPanel(e.panel);
            if (rid !== null) { lastResourceTabIdRef.current = e.panel.id; setActiveResourceId(rid); }
        });
        // Seed from whatever tab is active after a restore (the change event only fires on changes),
        // so a reload with a resource tab active still highlights its node.
        const active = api.activePanel;
        if (active && isResourceTabId(active.id)) {
            lastResourceTabIdRef.current = active.id;
            setActiveResourceId(resourceIdOfPanel(active));
        }
        // Seed the stable container width + group count.
        lastContainerWRef.current = dockRef.current?.clientWidth || 0;
        lastGroupCountRef.current = api.groups.length;
        captureZoneSizes();
        syncZones();
    }, [buildDefault, syncZones, captureZoneSizes, reconcileZones, pinSideWidths, restoreRevealedZones]);

    // Data-driven: open/close the Code window following the "View code" target.
    useEffect(() => {
        const api = apiRef.current;
        if (!api) return;
        const existing = api.getPanel('code');
        if (codeView && !existing) ensurePanel('code');
        else if (!codeView && existing) existing.api.close();
    }, [codeView, ensurePanel]);

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
    // sigils). A diagram is identified by its name, so the id is never shown; an unnamed
    // diagram (the auto-namer failed) falls back to a neutral placeholder, not the id.
    function chatLabel(c) {
        return c.name || 'Untitled sigil';
    }

    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    const selectedChat = chats.find((c) => c.chatId === chatId) || null;

    // Deployment consistency of the selected sigil: resources whose own `deployed` state
    // (backfilled by the backend) diverges from the sigil mode — e.g. a failed create on a
    // Live sigil, or something deployed early on a Design one. Drives the top-bar warning
    // icon, and the Details panel shows the count. External actors (internet / end user)
    // can never be deployed, so they never count as divergent.
    const divergentCount = resources.filter(
        (r) => !isExternalResource(r) && (r.deployed === true) !== deployed
    ).length;
    const mixed = divergentCount > 0;

    // First-run state: the guide is up until the account has BOTH a token and a first sigil. Null
    // once set up (or while /api/tokens is still in flight, so an established user never sees a
    // flash of onboarding).
    // Both sources must have answered first — otherwise their load order decides whether an
    // established user gets onboarded.
    const hasToken = tokenInfo.dev || tokenInfo.count > 0;
    const onboarding = (!tokenInfo.loading && chatsLoaded && (!hasToken || chats.length === 0))
        ? { hasToken, hasSigil: chats.length > 0 }
        : null;

    // Effects below key off primitives, not the `onboarding` object — it's rebuilt every render.
    const onboardingActive = onboarding !== null;
    const awaitingFirstSigil = onboardingActive && chats.length === 0;

    // This sigil's own display preferences — falls back to the defaults (today's actual look) when
    // this chatId has never saved anything. Memoized so Diagram's vizPrefs-keyed effect (which
    // must NOT re-run on every unrelated render) sees a stable reference between renders.
    const vizPrefs = useMemo(
        () => normalizeVizPrefs({ ...DEFAULT_VIZ_PREFS, ...(allVizPrefs[chatId] || {}) }),
        [allVizPrefs, chatId]
    );
    const setVizPref = useCallback((key, value) => {
        if (!chatId) return;
        setAllVizPrefs((prev) => {
            const next = { ...prev, [chatId]: { ...DEFAULT_VIZ_PREFS, ...prev[chatId], [key]: value } };
            saveVizPrefs(next);
            return next;
        });
    }, [chatId]);
    // The SVG to display. Deliberately independent of every display PREFERENCE: swapping the string
    // makes React replace the whole injected SVG, which flashes, re-wires all the tooltip/badge
    // listeners, and (via Diagram's fit-on-new-svg effect) throws away the user's zoom and pan. So
    // the toggles never change this — hiding labels is a CSS class on the already-injected SVG
    // (`viz-hide-conn-labels`), and hiding step numbers is an in-place text edit. Both are possible
    // because every rendered variant shares one geometry: labels are injected onto a layout computed
    // without them, so the labelled and label-free views are pixel-identical apart from the text.
    // Only genuinely new server data changes this value.
    const displaySvg = useMemo(
        () => (hasSteps ? (svgActionSteps || svg) : svg),
        [svg, svgActionSteps, hasSteps]
    );

    // Step 3 can't come over the WebSocket: the server only pushes to sockets subscribed to a
    // specific chatId, and a brand-new user has no chat selected — so their agent's first push
    // would never reach us. Poll instead, but only while the guide is waiting on it.
    useEffect(() => {
        if (!awaitingFirstSigil) return;
        const id = setInterval(loadChats, 5000);
        return () => clearInterval(id);
    }, [awaitingFirstSigil]);

    // Open "Connect agent" for the user the very first time they land without being set up, then
    // never again — the guide stays on the canvas as the non-intrusive reminder.
    useEffect(() => {
        if (!onboardingActive) return;
        try {
            if (localStorage.getItem(ONBOARDED_KEY) === '1') return;
            localStorage.setItem(ONBOARDED_KEY, '1');
        } catch { /* quota / disabled storage — just don't auto-open */ return; }
        setConnectOpen(true);
    }, [onboardingActive]);

    function copy(text, key) {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(key);
        setTimeout(() => setCopied((k) => (k === key ? '' : k)), 1500);
    }

    // Everything the dockview panels read. Recreated per render (cheap for this UI); panels
    // pull only what they need via useDeployed().
    // The node the diagram highlights: the resource of the active detail tab.
    const diagramSelectedId = activeResourceId;

    const ctx = {
        onboarding,
        svg: displaySvg, hasSteps, renderError, resources,
        selectResource, diagramSelectedId,
        codeView, setCodeView, openCode,
        chatId, chatsCount: chats.length,
        selectedChat, deployed, mixed, divergentCount,
        editingName, setEditingName, renameValue, setRenameValue,
        renameError, setRenameError,
        renameChat, cancelRename, startRename, formatDate, copy, copied,
        confirmDelete, setConfirmDelete, deleteChat, deleting,
        openConnectAgent,
        vizPrefs, setVizPref,
        // Panels are rendered by dockview outside the React tree, so this is how they learn they
        // are on a public page — AskPanel uses it to offer signing up instead of a chat.
        share
    };

    const isOpen = (id) => openIds.includes(id);

    return (
        <DeployedContext.Provider value={ctx}>
            <header className="topbar" role="banner">
                <div className="topbar-left">
                    <div className="brand">
                        <Logo size={22} className="brand-mark" />
                        <h1>Sigilum</h1>
                    </div>
                    <span className="topbar-sep" aria-hidden="true" />
                    <div className="topbar-group" role="group" aria-label="Panel layout">
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={resetLayout}
                            title="Reset panel layout"
                            aria-label="Reset panel layout"
                        >
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <rect x="3" y="4" width="18" height="16" rx="2" />
                                <line x1="3" y1="10" x2="21" y2="10" />
                                <polyline points="7.5 15 6 16.5 7.5 18" />
                                <path d="M6 16.5h4.5a2 2 0 0 0 2-2" />
                            </svg>
                        </button>
                        <div className="zone-toggles" role="group" aria-label="Show or hide zones">
                            <button
                                type="button"
                                className="zone-toggle icon-btn"
                                onClick={() => toggleZone('left')}
                                aria-pressed={zoneState('left') === 'visible'}
                                title="Show or hide the left sidebar"
                                aria-label="Show or hide the left sidebar"
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
                                title="Show or hide the bottom panel"
                                aria-label="Show or hide the bottom panel"
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
                                title="Show or hide the right sidebar"
                                aria-label="Show or hide the right sidebar"
                            >
                                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                                    <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                                    <rect x="15" y="4" width="6" height="16" rx="1.5" fill="currentColor" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
                <div className="topbar-center">
                    {share ? (
                        <span className="topbar-shared-name" title={sharedName}>{sharedName}</span>
                    ) : <SigilSelect
                        chats={chats}
                        chatId={chatId}
                        onSelect={setChatId}
                        onRefresh={loadChats}
                        chatLabel={chatLabel}
                        mixed={mixed}
                        deployed={deployed}
                    />}
                </div>
                <div className="topbar-right">
                    {!share && <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => togglePanel('settings')}
                        aria-expanded={isOpen('settings')}
                        disabled={!chatId}
                        title="Sigil options — rename, display, data and delete"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                        Options
                    </button>}
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => togglePanel('ask')}
                        aria-expanded={isOpen('ask')}
                        disabled={!chatId}
                        title="Ask anything about this diagram"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        Ask
                    </button>
                    {!share && <button
                        type="button"
                        className="btn btn-ghost btn-opencode"
                        onClick={() => togglePanel('devtools')}
                        aria-expanded={isOpen('devtools')}
                        title="Show the opencode panel"
                    >
                        <img className="btn-opencode-logo" src="/opencode.png" alt="opencode" />
                    </button>}
                    {!share && <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setShareOpen(true)}
                        aria-haspopup="dialog"
                        disabled={!chatId}
                        title="Create a public link to this sigil"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="18" cy="5" r="3" />
                            <circle cx="6" cy="12" r="3" />
                            <circle cx="18" cy="19" r="3" />
                            <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
                            <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
                        </svg>
                        Share
                    </button>}
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setExportOpen(true)}
                        aria-haspopup="dialog"
                        disabled={!svg}
                        title="Export this sigil as an image"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Export
                    </button>
                    <span className="topbar-sep" aria-hidden="true" />
                    {share
                        ? <a className="btn btn-primary" href="/">Sign in to Sigilum</a>
                        : user && <UserMenu user={user} onUserChange={onUserChange} onOpenAdmin={onOpenAdmin} />}
                </div>
            </header>
            <main id="main-content" className="layout layout-deployed" role="main">
                <div className="deployed-state">
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
            </main>
            {/* Refetch tokens on close so the guide's step 1 ticks as soon as one is generated. */}
            {connectOpen && <ConnectAgentModal onClose={() => { setConnectOpen(false); loadTokens(); }} />}
            {shareOpen && <ShareModal chatId={chatId} deployed={deployed} onClose={() => setShareOpen(false)} />}
            {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
        </DeployedContext.Provider>
    );
}
