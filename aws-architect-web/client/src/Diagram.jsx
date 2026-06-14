import { useEffect, useRef, useCallback } from 'react';

export default function Diagram({ svg, renderError }) {
    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const view = useRef({ scale: 1, x: 0, y: 0, panning: false, startX: 0, startY: 0 });

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
        Object.assign(view.current, { scale, x, y });
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
            const handlers = {
                ArrowLeft:  () => { view.current.x += PAN_STEP; scheduleApply(); },
                ArrowRight: () => { view.current.x -= PAN_STEP; scheduleApply(); },
                ArrowUp:    () => { view.current.y += PAN_STEP; scheduleApply(); },
                ArrowDown:  () => { view.current.y -= PAN_STEP; scheduleApply(); },
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

        return () => {
            stage.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
            stage.removeEventListener('wheel', onWheel);
            stage.removeEventListener('keydown', onKeyDown);
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
        </div>
    );
}
