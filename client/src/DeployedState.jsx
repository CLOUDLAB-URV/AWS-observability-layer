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

// dockview panel registry (id → component). The layout is constrained to an IDE-like
// model: the diagram is the fixed centre anchor and every other panel lives in one of
// three zones — left / right (each a third of the width) or bottom. One group per zone;
// panels opened into the same zone stack as tabs.
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
    devtools: { title: 'opencode / Claude Code', zone: 'left' }
};
// Zone → the dockview direction used to create that zone's group next to the diagram.
const ZONE_DIRECTION = { left: 'left', right: 'right', bottom: 'below' };

// A close-less tab renderer for the diagram: it's the anchor panel, so it must not be
// closable (no ✕, and none exists). Every other panel keeps the default closable tab.
function PlainTab(props) {
    return <div className="dv-plain-tab" title={props.api.title}>{props.api.title}</div>;
}
const TAB_COMPONENTS = { plain: PlainTab };

// Root-edge drop targets (the only way to create the bottom zone): a 60px activation band
// so the gesture is easy to hit, and a 25%-tall overlay so the preview shows the real
// full-width strip the drop will create. (Left/right/top root edges are blocked in
// onWillShowOverlay; only the bottom one ever shows.)
const DND_EDGES = {
    activationSize: { type: 'pixels', value: 60 },
    size: { type: 'percentage', value: 25 }
};

// Side zones are a third of the width; the bottom zone is a fixed height. The diagram
// takes whatever is left (2/3 with one side open, 1/3 with both). Only resize when off by
// more than this tolerance, so the auto-snap converges instead of looping.
const BOTTOM_ZONE_HEIGHT = 260;
const SIZE_TOLERANCE = 8;

// Bump the suffixes when panel ids / defaults change so stale saved state is ignored.
const LAYOUT_KEY = 'viz-dock-layout-v5';
const ZONES_KEY = 'viz-dock-zones-v5';

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

// "Deployed state" view: subscribes to one chat on the visualizer socket and
// renders a live diagram of what is actually deployed in AWS (pushed from the
// user's agent via the MCP tool). Each chat has its own isolated diagram. The
// diagram + all side panels live in a VSCode-like dockview layout the user can
// rearrange (drag/dock/float/resize); the arrangement is persisted to localStorage.
export default function DeployedState() {
    const [connected, setConnected] = useState(false);
    const [chats, setChats] = useState([]);
    const [chatId, setChatId] = useState('');
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
    const [agent, setAgent] = useState('opencode'); // 'opencode' | 'claude'
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
    const normRaf = useRef(0);              // pending normalize rAF
    const normTimer = useRef(0);            // delayed normalize catch-up (post-close settle)
    const animTimer = useRef(0);            // removes the .viz-dock--animating class
    const bottomSizedRef = useRef(null);    // id of the bottom group we've already height-seeded
    const [openIds, setOpenIds] = useState([]);

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
            // No auto-select: the diagram only appears once the user picks a chat.
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

    // Snap the layout to the zone model: each left/right zone group to a third of the width
    // (the diagram takes the rest), the bottom zone to a fixed height. Also refreshes the
    // remembered zone of every open panel. Idempotent — it only calls setSize() when a group
    // is off by more than SIZE_TOLERANCE, so re-running it (e.g. after dockview's own
    // redistribution when a group closes) converges in a frame or two and then stops. Runs on
    // every layout change; the smoothing class is added only when it actually resizes something.
    const normalizeLayout = useCallback(() => {
        const api = apiRef.current;
        const container = dockRef.current;
        if (!api || !container) return;
        const diagramGroup = api.getPanel('diagram')?.group;
        if (!diagramGroup) return;
        const thirdW = Math.round(container.clientWidth / 3);

        let changed = false;
        let bottomGroup = null;
        for (const group of api.groups) {
            if (group === diagramGroup) continue;
            const zone = zoneOfGroup(group, diagramGroup);
            // Sides are locked to a third of the width (auto-snap). The bottom is full-width and its
            // HEIGHT is left free to resize — we only give it an initial height once (below).
            if ((zone === 'left' || zone === 'right')) {
                const rect = group.element.getBoundingClientRect();
                if (Math.abs(rect.width - thirdW) > SIZE_TOLERANCE) {
                    group.api.setSize({ width: thirdW });
                    changed = true;
                }
            } else if (zone === 'bottom') {
                bottomGroup = group;
            }
        }

        // Make the bottom zone span the FULL width. A bottom drop lands as a narrow group split off
        // the diagram column; relocate its panels into a fresh full-width group at the root's bottom
        // edge. Idempotent: once full-width it's skipped, so this converges after one pass.
        if (bottomGroup) {
            const bw = bottomGroup.element.getBoundingClientRect().width;
            if (bw < container.clientWidth * 0.9) {
                const full = api.addGroup({ direction: 'below' });
                for (const p of [...bottomGroup.panels]) {
                    p.api.moveTo({ group: full, position: 'center' });
                }
                bottomGroup = full;
                bottomSizedRef.current = null;
                changed = true;
            }
        }

        // Seed the bottom zone's height exactly once per group, then never touch it again so the
        // user can drag the top/bottom sash to make it taller (it no longer snaps back).
        if (bottomGroup) {
            if (bottomSizedRef.current !== bottomGroup.id) {
                bottomSizedRef.current = bottomGroup.id;
                bottomGroup.api.setSize({ height: BOTTOM_ZONE_HEIGHT });
                changed = true;
            }
        } else {
            bottomSizedRef.current = null;
        }

        // Remember where each open panel currently lives.
        const zones = { ...zonesRef.current };
        for (const panel of api.panels) {
            if (panel.id === 'diagram') continue;
            const z = zoneOfGroup(panel.group, diagramGroup);
            if (z) zones[panel.id] = z;
        }
        zonesRef.current = zones;
        saveZones(zones);

        if (changed) {
            container.classList.add('viz-dock--animating');
            clearTimeout(animTimer.current);
            animTimer.current = setTimeout(() => container.classList.remove('viz-dock--animating'), 280);
        }
        persist(api);
    }, [persist]);

    // Snap on the next frame (immediate feel for open/move) AND again after a short delay:
    // when a group closes, dockview redistributes the freed space to an equal split *after*
    // our rAF and without firing another layout event, so the delayed pass is what makes the
    // remaining side settle back to a third. normalizeLayout is idempotent, so running twice
    // is harmless.
    const scheduleNormalize = useCallback(() => {
        cancelAnimationFrame(normRaf.current);
        normRaf.current = requestAnimationFrame(() => normalizeLayout());
        clearTimeout(normTimer.current);
        normTimer.current = setTimeout(() => normalizeLayout(), 160);
    }, [normalizeLayout]);

    // Open a panel into its remembered zone: stack as a tab in that zone's group if one
    // exists, else create the zone group beside the diagram. No-op if already open.
    const ensurePanel = useCallback((id) => {
        const api = apiRef.current;
        if (!api || api.getPanel(id)) return;
        const meta = PANEL_META[id];
        const zone = zonesRef.current[id] || meta.zone;
        const diagram = api.getPanel('diagram');
        const diagramGroup = diagram?.group;
        let zoneGroup = null;
        if (diagramGroup) {
            for (const g of api.groups) {
                if (g !== diagramGroup && zoneOfGroup(g, diagramGroup) === zone) { zoneGroup = g; break; }
            }
        }
        if (zoneGroup) {
            api.addPanel({ id, component: id, title: meta.title, position: { referenceGroup: zoneGroup, direction: 'within' } });
        } else if (zone === 'bottom') {
            // The bottom zone is a full-width strip at the root (below the whole top row), not a
            // split of the diagram column. An AbsolutePosition (direction only, no reference) docks
            // it to the root's bottom edge spanning the entire width.
            api.addPanel({ id, component: id, title: meta.title, position: { direction: 'below' }, initialHeight: BOTTOM_ZONE_HEIGHT });
        } else if (diagram) {
            api.addPanel({ id, component: id, title: meta.title, position: { referencePanel: 'diagram', direction: ZONE_DIRECTION[zone] } });
        } else {
            api.addPanel({ id, component: id, title: meta.title });
        }
        scheduleNormalize();
    }, [scheduleNormalize]);

    // The default arrangement: opencode on the left, a right group stacking connect-agent /
    // guide / explanation as tabs, and the (non-closable) diagram in the centre. Also resets
    // the remembered zones to their defaults.
    const buildDefault = useCallback((api) => {
        api.clear();
        zonesRef.current = { ...DEFAULT_ZONES };
        saveZones(zonesRef.current);
        api.addPanel({ id: 'diagram', component: 'diagram', title: 'Diagram', tabComponent: 'plain' });
        api.addPanel({ id: 'devtools', component: 'devtools', title: PANEL_META.devtools.title,
            position: { referencePanel: 'diagram', direction: 'left' } });
        api.addPanel({ id: 'connect-agent', component: 'connect-agent', title: PANEL_META['connect-agent'].title,
            position: { referencePanel: 'diagram', direction: 'right' } });
        const rightGroup = api.getPanel('connect-agent').group;
        api.addPanel({ id: 'explanation', component: 'explanation', title: PANEL_META.explanation.title,
            position: { referenceGroup: rightGroup, direction: 'within' } });
        api.addPanel({ id: 'guide', component: 'guide', title: PANEL_META.guide.title,
            position: { referenceGroup: rightGroup, direction: 'within' } });
        api.getPanel('guide')?.api.setActive();
        scheduleNormalize();
    }, [scheduleNormalize]);

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

    const openConnectAgent = useCallback(() => ensurePanel('connect-agent'), [ensurePanel]);

    // Discard the saved layout AND the remembered zones, then rebuild the default.
    const resetLayout = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;
        try { localStorage.removeItem(LAYOUT_KEY); localStorage.removeItem(ZONES_KEY); } catch { /* ignore */ }
        zonesRef.current = { ...DEFAULT_ZONES };
        buildDefault(api);
    }, [buildDefault]);

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

        // Enforce exactly one slot per zone: one group on the left, one on the right, and one
        // FULL-WIDTH strip at the bottom, with the diagram in the centre. A panel can only be
        // STACKED (as a tab) onto an existing zone group — never dropped beside it to make a second
        // column. Sides are created off the diagram; the bottom is created at the component's bottom
        // edge (root, spanning the whole width).
        api.onWillShowOverlay((e) => {
            const diagramGroup = api.getPanel('diagram')?.group;
            const onDiagram = !!(e.group && diagramGroup && e.group.id === diagramGroup.id);
            const occupied = () => new Set(
                api.groups.filter((g) => g !== diagramGroup).map((g) => zoneOfGroup(g, diagramGroup))
            );

            // Whole-component edge drop: allow ONLY the bottom edge (a full-width root-bottom strip),
            // and only while there's no bottom yet. Left/right/top outer edges are never allowed.
            if (e.kind === 'edge') {
                if (!(e.position === 'bottom' && !occupied().has('bottom'))) e.preventDefault();
                return;
            }

            // Dropping onto a tab bar = stacking. Fine, except onto the diagram (keep it alone).
            if (e.kind === 'tab' || e.kind === 'header_space') {
                if (onDiagram) e.preventDefault();
                return;
            }

            // e.kind === 'content': a directional drop inside a group.
            if (!e.group) { e.preventDefault(); return; }
            if (onDiagram) {
                // Only left/right zones may be created off the diagram, each only while empty. The
                // bottom zone is created exclusively via the root bottom edge (generous activation
                // band set through dndEdges) so its overlay preview is the true full-width strip —
                // a content-bottom drop here would preview at diagram width, which is misleading.
                if (e.position === 'left' || e.position === 'right') {
                    if (occupied().has(e.position)) e.preventDefault();
                } else {
                    e.preventDefault();
                }
            } else {
                // An existing side/bottom group: only stack on top (centre); block the edges so no
                // second column/row can appear beside it.
                if (e.position !== 'center') e.preventDefault();
            }
        });
        // The diagram itself can't be dragged out of the centre.
        api.onWillDragPanel((e) => {
            if (e.panel?.id === 'diagram') e.nativeEvent.preventDefault();
        });
        api.onWillDragGroup((e) => {
            if (e.group?.panels?.some((p) => p.id === 'diagram')) e.nativeEvent.preventDefault();
        });

        setOpenIds(api.panels.map((p) => p.id));
        api.onDidLayoutChange(() => {
            persist(api);
            setOpenIds(api.panels.map((p) => p.id));
            // If the user closed the resource-detail tab manually, clear the selection so the
            // diagram highlight goes away and a later click can reopen it.
            if (!api.getPanel('resource-detail') && selectedResourceRef.current) {
                setSelectedResource(null);
            }
            scheduleNormalize();
        });
        scheduleNormalize();
    }, [buildDefault, persist, scheduleNormalize]);

    // Data-driven: open/close the resource-detail panel following the diagram selection.
    useEffect(() => {
        const api = apiRef.current;
        if (!api) return;
        const existing = api.getPanel('resource-detail');
        if (selectedResource && !existing) ensurePanel('resource-detail');
        else if (!selectedResource && existing) existing.api.close();
    }, [selectedResource, ensurePanel]);

    // The dropdown shows only the human name (fall back to a short id for unnamed
    // chats). Dates / full id / rename live in the Details panel.
    function chatLabel(c) {
        return c.name || `Chat ${c.chatId.slice(0, 8)}`;
    }

    function formatDate(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    const selectedChat = chats.find((c) => c.chatId === chatId) || null;

    // Server name. In local dev use a distinct "-local" name + VISUALIZER_URL so this MCP targets
    // the local server and coexists with the hosted one a user already has. In production it's a
    // unique-per-OS-user name ($USER expands when pasted into a shell), safe to run anywhere.
    const SERVER_NAME = dev ? 'diagram-state-visualizer-local' : 'diagram-state-visualizer-$USER';
    // In dev the token is the fixed env one (always known). Otherwise use the freshly generated
    // token if we have one; the secret of an existing token is never returned to the UI, so a
    // ready-to-paste command is only possible right after generating it.
    const tokenForCmd = dev ? devToken : (newToken || TOKEN_PLACEHOLDER);
    // In dev, point the MCP at the local server; in prod it defaults to the hosted deployment.
    const urlEnv = dev && visualizerUrl ? ` VISUALIZER_URL=${visualizerUrl}` : '';
    const claudeUrlFlag = dev && visualizerUrl ? `\n    --env VISUALIZER_URL=${visualizerUrl} \\` : '';
    // Ready-to-paste Claude Code CLI command: registers the published MCP at user scope
    // (loaded in every session on this machine) with the token baked in.
    const claudeAddCommand = `claude mcp add --scope user ${SERVER_NAME} \\
    --env VISUALIZER_TOKEN=${tokenForCmd} \\${claudeUrlFlag}
    -- npx -y diagram-state-visualizer-mcp@latest`;
    const claudeRemoveCommand = `claude mcp remove --scope user ${SERVER_NAME}`;
    // opencode in production: one command that installs opencode if needed and writes the MCP entry
    // into ~/.config/opencode/opencode.json (idempotent — re-running only refreshes the token). The
    // token goes via env var (same name the MCP reads), so it's not stored as a CLI flag.
    // In dev we can't use that helper: it owns the single `diagram-state-visualizer` key, so it
    // would clobber a user's hosted entry. Show a manual `-local` entry instead, which coexists.
    const opencodeDevSnippet = `"diagram-state-visualizer-local": {
  "type": "local",
  "command": ["npx", "-y", "diagram-state-visualizer-mcp@latest"],
  "enabled": true,
  "environment": {
    "VISUALIZER_TOKEN": "${tokenForCmd}",
    "VISUALIZER_URL": "${visualizerUrl}"
  }
}`;
    const opencodeAddCommand = dev
        ? opencodeDevSnippet
        : `VISUALIZER_TOKEN=${tokenForCmd}${urlEnv} npx -y @apozo/opencode-diagrammer-setup`;
    // Per-agent values driving the single step-2 block below.
    const addCommand = agent === 'claude' ? claudeAddCommand : opencodeAddCommand;

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
        agent, setAgent,
        claudeAddCommand, opencodeDevSnippet, addCommand, claudeRemoveCommand,
        openConnectAgent
    };

    const isOpen = (id) => openIds.includes(id);

    return (
        <DeployedContext.Provider value={ctx}>
            <div className="deployed-state">
                <div className="deployed-toolbar">
                    <div className="project-form">
                        <label htmlFor="viz-chat">Chat</label>
                        <select
                            id="viz-chat"
                            value={chatId}
                            onChange={(e) => setChatId(e.target.value)}
                        >
                            <option value="">{chats.length ? 'Select a chat…' : 'No chats yet'}</option>
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
                            title="Refresh chats"
                            aria-label="Refresh chats"
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
                            aria-label={`Diagram mode: ${deployed ? 'Live, deployed to AWS' : 'Design, not deployed'}`}
                        >
                            {deployed ? 'Live' : 'Design'}
                        </span>
                    )}
                    {chatId && (
                        <button
                            type="button"
                            className="details-btn"
                            onClick={() => togglePanel('details')}
                            aria-expanded={isOpen('details')}
                        >
                            Details
                        </button>
                    )}
                    {chatId && (
                        <button
                            type="button"
                            className="explain-btn"
                            onClick={() => togglePanel('explanation')}
                            aria-expanded={isOpen('explanation')}
                            title="Explain this diagram component by component"
                        >
                            📖 Explain
                            {explanation?.outdated && <span className="explain-dot" aria-hidden="true" />}
                        </button>
                    )}
                    <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`} role="status">
                        {connected ? 'live' : 'reconnecting…'}
                    </span>
                    <button
                        type="button"
                        className="details-btn"
                        onClick={resetLayout}
                        title="Reset the panel layout to its default"
                    >
                        ⤢ Reset layout
                    </button>
                    <button
                        className="guide-btn"
                        onClick={() => togglePanel('devtools')}
                        aria-expanded={isOpen('devtools')}
                        title="Show the opencode / Claude Code panel"
                    >
                        ⌘ opencode
                    </button>
                    <button
                        className="guide-btn"
                        onClick={() => togglePanel('guide')}
                        aria-expanded={isOpen('guide')}
                    >
                        📘 Guide
                    </button>
                    <button
                        className="settings-btn"
                        onClick={() => togglePanel('connect-agent')}
                        aria-expanded={isOpen('connect-agent')}
                    >
                        ⚙ Connect agent
                    </button>
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
                        onReady={onReady}
                    />
                </div>
            </div>
        </DeployedContext.Provider>
    );
}
