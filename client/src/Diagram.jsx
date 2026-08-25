import { useEffect, useRef, useCallback } from 'react';
import { findArn, shortArn } from './awsLinks.js';
import { isExternalResource } from './externalResource.js';
import { baseId, decodeNodePath, edgeTouchesPath, isContainerPath, isEdgeGroup, isExternalNode, isSemanticGroup, sanitizeId } from './svgClassify.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Shift-click opens a service in its OWN detail tab (several stay open at once) — a gesture nobody
// finds on their own. The node tooltip carries a one-line hint until the user actually uses it once,
// then retires for good; the corner shortcut strip keeps it discoverable afterwards.
const SHIFT_HINT_KEY = 'viz.shiftTabHintUsed';
function shiftHintSeen() {
    try { return localStorage.getItem(SHIFT_HINT_KEY) === '1'; } catch { return false; }
}
function markShiftHintSeen() {
    try { localStorage.setItem(SHIFT_HINT_KEY, '1'); } catch { /* quota */ }
}

// Small corner badge injected INTO a node's <g> (so it pans/zooms with the diagram for
// free): marks a resource whose deployment state diverges from the sigil mode. `isDeployed`
// true → green check ("deployed although this is a Design sigil"); false → amber "!"
// ("not deployed although this is a Live sigil").
function makeBadge(g, isDeployed) {
    let bbox;
    try {
        bbox = g.getBBox();
    } catch {
        return null;
    }
    if (!bbox || !bbox.width) return null;
    const cx = bbox.x + bbox.width - 3;
    const cy = bbox.y + 3;
    const badge = document.createElementNS(SVG_NS, 'g');
    badge.setAttribute('class', `svc-badge ${isDeployed ? 'svc-badge-live' : 'svc-badge-warn'}`);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', 9);
    badge.appendChild(circle);
    if (isDeployed) {
        const check = document.createElementNS(SVG_NS, 'path');
        check.setAttribute('d', `M ${cx - 4} ${cy} l 2.6 3 l 5.2 -6`);
        check.setAttribute('class', 'svc-badge-glyph');
        badge.appendChild(check);
    } else {
        const mark = document.createElementNS(SVG_NS, 'text');
        mark.setAttribute('x', cx);
        mark.setAttribute('y', cy);
        mark.setAttribute('text-anchor', 'middle');
        mark.setAttribute('dominant-baseline', 'central');
        mark.setAttribute('class', 'svc-badge-glyph-text');
        mark.textContent = '!';
        badge.appendChild(mark);
    }
    g.appendChild(badge);
    return badge;
}

// lineThickness is a px stroke width; animationSpeed is a flow-cycle duration in seconds. Defaults
// reproduce D2's fixed stroke-width:2 and the original 0.9s flow (DeployedState normalizes any
// legacy string values to numbers before they reach here).
const DEFAULT_VIZ_PREFS = {
    showConnectionLabels: true,
    showServiceLabels: true,
    showGroupBoxes: true,
    showExternalActor: true,
    lineThickness: 2,
    dashedLines: false,
    animateArrows: false,
    animationSpeed: 0.9
};

export default function Diagram({
    svg, renderError, resources = [], onSelectResource, selectedId, sigilDeployed = false,
    vizPrefs = DEFAULT_VIZ_PREFS
}) {
    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const tooltipRef = useRef(null);
    // A ref, not state: the tooltip is built imperatively, so retiring the hint must not re-render.
    const hintDoneRef = useRef(shiftHintSeen());
    // `userAdjusted` tracks whether the user has manually panned/zoomed. While false,
    // the diagram stays auto-fit & centered (and refits on stage resize); once the
    // user interacts we leave their view alone.
    const view = useRef({ scale: 1, x: 0, y: 0, panning: false, startX: 0, startY: 0, userAdjusted: false });

    const applyTransform = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { x, y, scale } = view.current;
        canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }, []);

    const fitToScreen = useCallback(() => {
        const stage = stageRef.current;
        const canvas = canvasRef.current;
        if (!stage || !canvas) return;

        // Read SVG intrinsic size from its attributes (set by server's prepareSvgForEmbed).
        // Avoids relying on scrollWidth which can be stale during layout transitions.
        const svg = canvas.querySelector('svg');
        const svgW = svg ? parseFloat(svg.getAttribute('width')) : 0;
        const svgH = svg ? parseFloat(svg.getAttribute('height')) : 0;
        if (!svgW || !svgH) return;

        const stageW = stage.clientWidth;
        const stageH = stage.clientHeight;
        const pad = 40; // breathing room around the diagram

        const scale = Math.min(
            (stageW - pad * 2) / svgW,
            (stageH - pad * 2) / svgH,
            1
        );
        // Center the SVG inside the stage; the canvas has 24px CSS padding so offset by that.
        const x = (stageW - svgW * scale) / 2 - 24 * scale;
        const y = (stageH - svgH * scale) / 2 - 24 * scale;
        Object.assign(view.current, { scale, x, y, userAdjusted: false });
        applyTransform();
    }, [applyTransform]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;

        let rafId = null;
        const scheduleApply = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                applyTransform();
            });
        };

        const applyZoomAtPoint = (factor, cx, cy) => {
            const next = Math.max(0.05, Math.min(10, view.current.scale * factor));
            const actualFactor = next / view.current.scale;
            view.current.x = cx - (cx - view.current.x) * actualFactor;
            view.current.y = cy - (cy - view.current.y) * actualFactor;
            view.current.scale = next;
            view.current.userAdjusted = true;
            scheduleApply();
        };

        const onMouseDown = (event) => {
            if (event.target.closest('.diagram-toolbar')) return;
            event.preventDefault();
            view.current.startX = event.clientX - view.current.x;
            view.current.startY = event.clientY - view.current.y;
            view.current.panning = true;
        };
        const onMouseUp = () => { view.current.panning = false; };
        const onMouseMove = (event) => {
            if (!view.current.panning) return;
            event.preventDefault();
            view.current.x = event.clientX - view.current.startX;
            view.current.y = event.clientY - view.current.startY;
            view.current.userAdjusted = true;
            scheduleApply();
        };
        const onWheel = (event) => {
            event.preventDefault();
            const rect = stage.getBoundingClientRect();
            const mouseX = event.clientX - rect.left;
            const mouseY = event.clientY - rect.top;
            const zoomFactor = Math.exp((event.deltaY < 0 ? 1 : -1) * 0.1);
            applyZoomAtPoint(zoomFactor, mouseX, mouseY);
        };

        const onKeyDown = (event) => {
            const PAN_STEP = 40;
            const cx = stage.clientWidth / 2;
            const cy = stage.clientHeight / 2;
            const pan = (dx, dy) => { view.current.x += dx; view.current.y += dy; view.current.userAdjusted = true; scheduleApply(); };
            const handlers = {
                ArrowLeft:  () => pan(PAN_STEP, 0),
                ArrowRight: () => pan(-PAN_STEP, 0),
                ArrowUp:    () => pan(0, PAN_STEP),
                ArrowDown:  () => pan(0, -PAN_STEP),
                '+':        () => applyZoomAtPoint(1.15, cx, cy),
                '=':        () => applyZoomAtPoint(1.15, cx, cy),
                '-':        () => applyZoomAtPoint(0.87, cx, cy),
                '0':        () => fitToScreen(),
            };
            if (handlers[event.key]) {
                event.preventDefault();
                handlers[event.key]();
            }
        };

        // While Shift is held, the canvas advertises the "open in its own tab" gesture: nodes take
        // the copy cursor and a green hover glow. Window-level so it tracks even before the stage
        // has focus; a window blur clears it (a Shift-held alt-tab never sends us the keyup).
        const syncShift = (event) => stage.classList.toggle('is-shift', event.shiftKey === true);
        const clearShift = () => stage.classList.remove('is-shift');

        stage.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);
        stage.addEventListener('wheel', onWheel, { passive: false });
        stage.addEventListener('keydown', onKeyDown);
        window.addEventListener('keydown', syncShift);
        window.addEventListener('keyup', syncShift);
        window.addEventListener('blur', clearShift);

        // Keep the diagram fit & centered when the stage resizes (window resize, the
        // Details panel opening, the chat panel docking/floating) — but only while the
        // user hasn't taken manual control of the view.
        const resizeObserver = new ResizeObserver(() => {
            if (view.current.userAdjusted) return;
            requestAnimationFrame(() => fitToScreen());
        });
        resizeObserver.observe(stage);

        return () => {
            stage.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
            stage.removeEventListener('wheel', onWheel);
            stage.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keydown', syncShift);
            window.removeEventListener('keyup', syncShift);
            window.removeEventListener('blur', clearShift);
            clearShift();
            resizeObserver.disconnect();
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [applyTransform, fitToScreen]);

    // Fit to screen when new SVG arrives (after DOM update).
    // Double RAF ensures the browser completes layout before we measure.
    useEffect(() => {
        if (!svg) {
            Object.assign(view.current, { x: 0, y: 0, scale: 1 });
            applyTransform();
            return;
        }
        let id1, id2;
        id1 = requestAnimationFrame(() => {
            id2 = requestAnimationFrame(() => fitToScreen());
        });
        return () => { cancelAnimationFrame(id1); cancelAnimationFrame(id2); };
    }, [svg, applyTransform, fitToScreen]);

    // Wire per-service interactivity onto the freshly embedded SVG: hover tooltip, hover/selected
    // highlight, and click → open the detail panel. Re-runs whenever the SVG, the resource
    // inventory, or the selection changes. Matches each D2 node (by its base64 path class) to a
    // resource via the sanitized id; connection groups and containers simply never match.
    useEffect(() => {
        const canvas = canvasRef.current;
        const tip = tooltipRef.current;
        if (!canvas || !svg) return;
        const svgEl = canvas.querySelector('svg');
        if (!svgEl) return;

        const byId = new Map();
        for (const r of resources) {
            const key = sanitizeId(r.id);
            if (key) byId.set(key, r);
        }

        const showTip = (resource, event) => {
            if (!tip) return;
            const region = resource.region ? ` · ${resource.region}` : '';
            const state = resource.state ? ` · ${resource.state}` : '';
            tip.innerHTML = '';
            const title = document.createElement('div');
            title.className = 'svc-tip-title';
            title.textContent = resource.name || resource.id || resource.type || 'Resource';
            const meta = document.createElement('div');
            meta.className = 'svc-tip-meta';
            meta.textContent = `${resource.type || 'resource'}${region}${state}`;
            // Cloud status line, always present so deployment state reads at a glance. External
            // actors (the internet / end user) live outside AWS — show a neutral status, never
            // the amber "not deployed" (there is nothing to deploy).
            const deployed = resource.deployed === true;
            const external = isExternalResource(resource);
            const status = document.createElement('div');
            status.className = `svc-tip-status ${external ? 'is-external' : deployed ? 'is-deployed' : 'is-undeployed'}`;
            status.textContent = external
                ? 'External — lives outside AWS'
                : deployed ? 'In the AWS cloud' : 'Not deployed to AWS';
            tip.append(title, meta, status);
            // Deployed resources really exist in AWS — surface their ARN (abbreviated) too.
            if (deployed) {
                const arn = findArn(resource);
                if (arn) {
                    const arnLine = document.createElement('div');
                    arnLine.className = 'svc-tip-arn';
                    arnLine.textContent = shortArn(arn);
                    tip.append(arnLine);
                }
            }
            // Teach the multi-tab gesture in place, only until it's been used once.
            if (!hintDoneRef.current) {
                const hint = document.createElement('div');
                hint.className = 'svc-tip-hint';
                hint.textContent = '⇧ Shift-click → open in a new tab';
                tip.append(hint);
            }
            tip.classList.add('is-visible');
            moveTip(event);
        };
        // Richer tooltip for the divergence badge: what the mark means + the agent's reason.
        const showBadgeTip = (resource, event) => {
            if (!tip) return;
            const deployed = resource.deployed === true;
            tip.innerHTML = '';
            const title = document.createElement('div');
            title.className = `svc-tip-title ${deployed ? 'svc-tip-live' : 'svc-tip-warn'}`;
            title.textContent = deployed
                ? 'Deployed to AWS'
                : 'Not deployed to AWS';
            const meta = document.createElement('div');
            meta.className = 'svc-tip-meta';
            meta.textContent = resource.deploy_note
                || (deployed
                    ? 'This resource is already live in AWS (deployed at your request) although the sigil is still a Design.'
                    : 'This resource does not exist in AWS yet — it is pending or was skipped.');
            tip.append(title, meta);
            tip.classList.add('is-visible');
            moveTip(event);
        };
        const moveTip = (event) => {
            if (!tip) return;
            const stage = stageRef.current;
            const rect = stage.getBoundingClientRect();
            let x = event.clientX - rect.left + 14;
            let y = event.clientY - rect.top + 14;
            // Keep the card inside the stage.
            x = Math.min(x, rect.width - tip.offsetWidth - 8);
            y = Math.min(y, rect.height - tip.offsetHeight - 8);
            tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
        };
        const hideTip = () => tip && tip.classList.remove('is-visible');

        const cleanups = [];
        const groups = svgEl.querySelectorAll('g[class]');

        // Cheap pre-scan: the external actor (Internet/user/browser…) can't be told apart from a
        // semantic group by a `byId` match alone (it's sometimes purely decorative, no backing
        // resource — see isExternalNode's comment), so its path set is collected structurally
        // first, before the main pass needs it to classify edges touching it. The same sweep
        // collects EVERY node path, because "is this a container?" is likewise only answerable by
        // looking at the whole set (see isContainerPath) and the main pass needs the answer to tell
        // a VPC/subnet box apart from a service icon.
        const externalPaths = new Set();
        const nodePaths = new Set();
        groups.forEach((g) => {
            const cls = g.getAttribute('class');
            if (isEdgeGroup(cls)) return;
            const path = decodeNodePath(cls);
            if (!path) return;
            nodePaths.add(path);
            if (isExternalNode(path)) externalPaths.add(path);
        });

        groups.forEach((g) => {
            const cls = g.getAttribute('class');
            // Tag connection groups and semantic group boxes (COMPUTE/DATA/MESSAGING/…) so the
            // display-preference CSS (toggled by the effect below) can target them. Neither gets
            // tooltip/click wiring — that stays scoped to resource nodes only.
            if (isEdgeGroup(cls)) {
                g.classList.add('svc-edge');
                for (const path of externalPaths) {
                    if (edgeTouchesPath(cls, path)) {
                        g.classList.add('svc-edge-external');
                        break;
                    }
                }
                return;
            }
            const path = decodeNodePath(cls);
            if (!path) return;
            if (isExternalNode(path)) {
                // Visually and behaviorally a service node (icon + label) — reusing .svc-node
                // means the existing hover/selected styling and the "hide service names" rule
                // both apply to it for free. Only wire tooltip/click/badge below if a backing
                // resource actually exists; when it doesn't, it just renders as a plain node.
                // Cleanup is mandatory here (unlike the effect-wide convention of leaving
                // svc-edge/svc-group untouched forever): without it, React 18 StrictMode's dev
                // double-invoke strips only 'svc-node' via the resource-wiring cleanup below and
                // leaves 'svc-external' behind, corrupting this element's class attribute with a
                // stray space — which breaks decodeNodePath's no-whitespace guard on the second
                // pass and silently drops the node's classification.
                g.classList.add('svc-node', 'svc-external');
                cleanups.push(() => g.classList.remove('svc-node', 'svc-external'));
            } else if (isSemanticGroup(path, byId)) {
                g.classList.add('svc-group');
                return;
            }
            // baseId so every copy of a multi-AZ resource opens the one resource behind it.
            const resource = byId.get(baseId(path.split('.').pop()));
            if (!resource) return;

            // A VPC/subnet box is backed by a resource just like an icon node, so it lands here and
            // gets the same tooltip/click/selection wiring for free. It only needs its own marker so
            // the CSS can treat it as the boundary it is (no icon-sized hover glow, and its name is
            // not a "service label" the display toggle should hide).
            const container = isContainerPath(path, nodePaths);
            g.classList.add('svc-node');
            if (container) {
                g.classList.add('svc-container');
            }
            // Comparing the RESOURCE (not the node path) means selecting one copy of a multi-AZ
            // service highlights every copy — which is how the user sees they are the same thing.
            if (selectedId && sanitizeId(resource.id) === sanitizeId(selectedId)) {
                g.classList.add('svc-selected');
            }

            // Divergence badge: mark resources whose deployment state differs from the sigil
            // mode (not deployed on a Live sigil / already deployed on a Design one). Hovering
            // the badge swaps the tooltip for the status + the agent's reason; leaving it
            // restores the normal resource tooltip (mouseenter/leave don't bubble).
            // External actors (internet / end user) are NEVER badged — they can't be deployed,
            // so "not in AWS" is their normal state, not a divergence.
            const isDeployed = resource.deployed === true;
            let badge = null;
            if (!isExternalResource(resource) && isDeployed !== (sigilDeployed === true)) {
                badge = makeBadge(g, isDeployed);
                if (badge) {
                    const onBadgeEnter = (e) => showBadgeTip(resource, e);
                    const onBadgeLeave = (e) => showTip(resource, e);
                    badge.addEventListener('mouseenter', onBadgeEnter);
                    badge.addEventListener('mouseleave', onBadgeLeave);
                    cleanups.push(() => {
                        badge.removeEventListener('mouseenter', onBadgeEnter);
                        badge.removeEventListener('mouseleave', onBadgeLeave);
                        badge.remove();
                    });
                }
            }

            let down = null;
            const onEnter = (e) => showTip(resource, e);
            const onMove = (e) => moveTip(e);
            const onLeave = () => hideTip();
            const onDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
            const onUp = (e) => {
                if (!down) return;
                const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
                down = null;
                if (moved < 6 && onSelectResource) {
                    e.stopPropagation();
                    hideTip();
                    // Shift-click pins the service into its own detail tab (several stay open at
                    // once); a plain click updates the shared preview tab.
                    if (e.shiftKey && !hintDoneRef.current) {
                        hintDoneRef.current = true;
                        markShiftHintSeen();
                    }
                    onSelectResource(resource, e.shiftKey);
                }
            };
            g.addEventListener('mouseenter', onEnter);
            g.addEventListener('mousemove', onMove);
            g.addEventListener('mouseleave', onLeave);
            g.addEventListener('pointerdown', onDown);
            g.addEventListener('pointerup', onUp);
            cleanups.push(() => {
                g.classList.remove('svc-node', 'svc-container', 'svc-selected');
                g.removeEventListener('mouseenter', onEnter);
                g.removeEventListener('mousemove', onMove);
                g.removeEventListener('mouseleave', onLeave);
                g.removeEventListener('pointerdown', onDown);
                g.removeEventListener('pointerup', onUp);
            });
        });

        return () => {
            hideTip();
            cleanups.forEach((fn) => fn());
        };
    }, [svg, resources, selectedId, onSelectResource, sigilDeployed]);

    // Apply the sigil's display preferences (Sigil Options → "Diagram display"). Deliberately a
    // separate, cheap effect from the node-wiring one above: flipping one of these toggles must
    // only swap CSS classes on the container, never tear down and reattach every tooltip/badge
    // listener (which would flash the divergence badges and hover state for no reason).
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.classList.toggle('viz-hide-conn-labels', vizPrefs.showConnectionLabels === false);
        canvas.classList.toggle('viz-hide-service-labels', vizPrefs.showServiceLabels === false);
        canvas.classList.toggle('viz-hide-groups', vizPrefs.showGroupBoxes === false);
        canvas.classList.toggle('viz-hide-external', vizPrefs.showExternalActor === false);
        // Animating implies dashed — an animated solid line has no dashes to move — so the two
        // classes are driven independently but "dashed" is OR'd with "animated" here rather than
        // stored back into vizPrefs.dashedLines, so turning animation back off later restores
        // whatever line style the user had actually chosen instead of a stuck forced value.
        const dashed = vizPrefs.dashedLines === true || vizPrefs.animateArrows === true;
        canvas.classList.toggle('viz-dashed-edges', dashed);
        canvas.classList.toggle('viz-animate-edges', vizPrefs.animateArrows === true);
        // lineThickness (px) and animationSpeed (seconds) are already numbers by the time they
        // reach here (DeployedState normalizes legacy strings); Number(...) || fallback guards any
        // stray value defensively.
        canvas.style.setProperty('--viz-edge-width', String(Number(vizPrefs.lineThickness) || 2));
        canvas.style.setProperty('--viz-edge-speed', `${Number(vizPrefs.animationSpeed) || 0.9}s`);
        // Step numbers ("2. GET /orders") live INSIDE the edge label text. The diagram is always
        // injected with the numbered variant, so the layout already reserves the number's width;
        // showing/hiding it is a pure in-place text edit on the already-injected <text> nodes — no
        // SVG swap, so flipping this toggle never re-lays-out or flashes the diagram (unlike swapping
        // to a differently-rendered variant). The original numbered text is stashed once per <text>
        // (dataset.stepFull) so the toggle is reversible; a fresh SVG injection re-stashes it.
        const showSteps = vizPrefs.showStepNumbers !== false;
        canvas.querySelectorAll('.svc-edge text').forEach((t) => {
            // A label broken over two lines is ONE <text> holding a <tspan> per line, and the step
            // number lives in the first one — so edit that tspan, never the <text>: writing its
            // textContent would delete the tspans and collapse the label back onto a single line.
            const target = t.querySelector('tspan') || t;
            if (target.dataset.stepFull == null) target.dataset.stepFull = target.textContent;
            const full = target.dataset.stepFull;
            // Root step / sub-step: "3. " or "3.1 ". Requiring an inner dot OR a trailing one keeps
            // an action that merely starts with digits ("200 OK response") from losing its number.
            target.textContent = showSteps ? full : full.replace(/^\s*\d+(?:(?:\.\d+)+|\.)\s+/, '');
        });
    }, [svg, vizPrefs]);

    const zoomIn = () => {
        const stage = stageRef.current;
        if (!stage) return;
        const cx = stage.clientWidth / 2;
        const cy = stage.clientHeight / 2;
        const next = Math.min(10, view.current.scale * 1.25);
        const factor = next / view.current.scale;
        view.current.x = cx - (cx - view.current.x) * factor;
        view.current.y = cy - (cy - view.current.y) * factor;
        view.current.scale = next;
        view.current.userAdjusted = true;
        applyTransform();
    };

    const zoomOut = () => {
        const stage = stageRef.current;
        if (!stage) return;
        const cx = stage.clientWidth / 2;
        const cy = stage.clientHeight / 2;
        const next = Math.max(0.05, view.current.scale * 0.8);
        const factor = next / view.current.scale;
        view.current.x = cx - (cx - view.current.x) * factor;
        view.current.y = cy - (cy - view.current.y) * factor;
        view.current.scale = next;
        view.current.userAdjusted = true;
        applyTransform();
    };

    return (
        <div
            className="stage"
            ref={stageRef}
            role="application"
            tabIndex={0}
            aria-label="Architecture diagram canvas. Use arrow keys to pan, plus or minus to zoom, zero to fit."
            aria-roledescription="Pannable and zoomable diagram canvas"
        >
            {svg ? (
                <>
                    <div
                        className="diagram-canvas"
                        ref={canvasRef}
                        dangerouslySetInnerHTML={{ __html: svg }}
                    />
                    {renderError && (
                        <div className="diagram-error-overlay" role="alert" title={renderError}>
                            ⚠ Couldn't render the latest update — showing the previous diagram.
                        </div>
                    )}
                </>
            ) : renderError ? (
                <div className="diagram-error" role="alert">{renderError}</div>
            ) : (
                <div className="diagram-empty">
                    Describe an architecture in the chat to generate a diagram.
                </div>
            )}

            {svg && (
                <div className="diagram-toolbar" aria-label="Diagram zoom controls">
                    <button className="diagram-toolbar-btn" onClick={zoomIn} title="Zoom in (+)" aria-label="Zoom in">+</button>
                    <button className="diagram-toolbar-btn" onClick={zoomOut} title="Zoom out (-)" aria-label="Zoom out">−</button>
                    <button className="diagram-toolbar-btn" onClick={fitToScreen} title="Fit to screen (0)" aria-label="Fit diagram to screen">⊡</button>
                </div>
            )}

            <span className="stage-kb-hint" aria-hidden="true">
                ↑↓←→ pan · +/- zoom · 0 fit · ⇧-click new tab
            </span>

            <div ref={tooltipRef} className="svc-tooltip" role="tooltip" aria-hidden="true" />
        </div>
    );
}
