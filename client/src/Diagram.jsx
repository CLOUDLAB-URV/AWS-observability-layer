import { useEffect, useRef, useCallback } from 'react';
import { findArn, shortArn } from './awsLinks.js';
import { isExternalResource } from './externalResource.js';

// Mirror of the sanitization the stateviz prompt applies to a resource id when it becomes a D2
// node id, so we can match a rendered SVG node back to its resource. Keep both in lockstep.
function sanitizeId(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// D2 (v0.7.0) tags each shape's outer <g> with class = base64(full node path), e.g.
// "YXdzLmxhbWJkYQ==" → "aws.lambda". Decode it; return the node path, or null for the connection
// groups (whose decoded text contains "(" / "->") and anything that isn't a clean dotted path.
function decodeNodePath(cls) {
    if (!cls || /\s/.test(cls) || !/^[A-Za-z0-9+/=]+$/.test(cls)) {
        return null;
    }
    let decoded;
    try {
        decoded = atob(cls);
    } catch {
        return null;
    }
    return /^[A-Za-z0-9_.]+$/.test(decoded) ? decoded : null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

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

export default function Diagram({ svg, renderError, resources = [], onSelectResource, selectedId, sigilDeployed = false }) {
    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const tooltipRef = useRef(null);
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

        stage.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);
        stage.addEventListener('wheel', onWheel, { passive: false });
        stage.addEventListener('keydown', onKeyDown);

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
        groups.forEach((g) => {
            const path = decodeNodePath(g.getAttribute('class'));
            if (!path) return;
            const resource = byId.get(path.split('.').pop());
            if (!resource) return;

            g.classList.add('svc-node');
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
                    onSelectResource(resource, e.shiftKey);
                }
            };
            g.addEventListener('mouseenter', onEnter);
            g.addEventListener('mousemove', onMove);
            g.addEventListener('mouseleave', onLeave);
            g.addEventListener('pointerdown', onDown);
            g.addEventListener('pointerup', onUp);
            cleanups.push(() => {
                g.classList.remove('svc-node', 'svc-selected');
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
                ↑↓←→ pan · +/- zoom · 0 fit
            </span>

            <div ref={tooltipRef} className="svc-tooltip" role="tooltip" aria-hidden="true" />
        </div>
    );
}
