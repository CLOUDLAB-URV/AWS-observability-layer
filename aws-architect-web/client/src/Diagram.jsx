import { useEffect, useRef } from 'react';

export default function Diagram({ svg, renderError }) {
    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const view = useRef({ scale: 1, x: 0, y: 0, panning: false, startX: 0, startY: 0 });

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;

        let rafId = null;
        const scheduleApply = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                const canvas = canvasRef.current;
                if (!canvas) return;
                const { x, y, scale } = view.current;
                canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
            });
        };

        const applyZoomAtPoint = (factor, cx, cy) => {
            view.current.x = cx - (cx - view.current.x) * factor;
            view.current.y = cy - (cy - view.current.y) * factor;
            view.current.scale *= factor;
            scheduleApply();
        };

        const onMouseDown = (event) => {
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

        // Keyboard pan/zoom when stage is focused
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
                '0':        () => {
                    Object.assign(view.current, { x: 0, y: 0, scale: 1 });
                    scheduleApply();
                },
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
    }, []);

    // Reset view when a new diagram arrives
    useEffect(() => {
        view.current.x = 0;
        view.current.y = 0;
        view.current.scale = 1;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.transform = 'translate(0px, 0px) scale(1)';
    }, [svg]);

    return (
        <div
            className="stage"
            ref={stageRef}
            role="application"
            tabIndex={0}
            aria-label="Architecture diagram canvas. Use arrow keys to pan, plus or minus to zoom, zero to reset view."
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
            <span className="stage-kb-hint" aria-hidden="true">
                ↑↓←→ pan · +/- zoom · 0 reset
            </span>
        </div>
    );
}
