import { useEffect, useRef } from 'react';

// SVG canvas with the same pan/zoom math as the extension's diagram-webview.js.
export default function Diagram({ svg, renderError }) {
    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const view = useRef({ scale: 1, x: 0, y: 0, panning: false, startX: 0, startY: 0 });

    useEffect(() => {
        const stage = stageRef.current;
        const canvas = canvasRef.current;
        if (!stage || !canvas) return;

        const apply = () => {
            const { x, y, scale } = view.current;
            canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
        };

        const onMouseDown = (event) => {
            event.preventDefault();
            view.current.startX = event.clientX - view.current.x;
            view.current.startY = event.clientY - view.current.y;
            view.current.panning = true;
        };
        const onMouseUp = () => {
            view.current.panning = false;
        };
        const onMouseMove = (event) => {
            if (!view.current.panning) return;
            event.preventDefault();
            view.current.x = event.clientX - view.current.startX;
            view.current.y = event.clientY - view.current.startY;
            apply();
        };
        const onWheel = (event) => {
            event.preventDefault();
            const rect = stage.getBoundingClientRect();
            const mouseX = event.clientX - rect.left;
            const mouseY = event.clientY - rect.top;
            const wheel = event.deltaY < 0 ? 1 : -1;
            const zoomFactor = Math.exp(wheel * 0.1);
            view.current.x = mouseX - (mouseX - view.current.x) * zoomFactor;
            view.current.y = mouseY - (mouseY - view.current.y) * zoomFactor;
            view.current.scale *= zoomFactor;
            apply();
        };

        stage.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            stage.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
            stage.removeEventListener('wheel', onWheel);
        };
    }, []);

    return (
        <div className="stage" ref={stageRef}>
            {renderError ? (
                <div className="diagram-error">{renderError}</div>
            ) : svg ? (
                <div
                    className="diagram-canvas"
                    ref={canvasRef}
                    dangerouslySetInnerHTML={{ __html: svg }}
                />
            ) : (
                <div className="diagram-empty" ref={canvasRef}>
                    Describe an architecture in the chat to generate a diagram.
                </div>
            )}
        </div>
    );
}
