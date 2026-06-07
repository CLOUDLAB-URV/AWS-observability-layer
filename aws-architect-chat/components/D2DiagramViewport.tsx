/* eslint-disable @next/next/no-img-element */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface D2DiagramViewportProps {
  d2Code: string;
  isDeploying?: boolean;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 6;
const ZOOM_INTENSITY = 0.1;

export default function D2DiagramViewport({ d2Code, isDeploying = false }: D2DiagramViewportProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const scaleRef = useRef(1);
  const pointRef = useRef({ x: 0, y: 0 });
  const startRef = useRef({ x: 0, y: 0 });
  const panningRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  const [pngSrc, setPngSrc] = useState('');
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState('');

  const applyTransform = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;

    layer.style.transform = `translate(${pointRef.current.x}px, ${pointRef.current.y}px) scale(${scaleRef.current})`;
  }, []);

  const scheduleTransform = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      applyTransform();
    });
  }, [applyTransform]);

  const resetAndFit = () => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) return;

    const stageRect = stage.getBoundingClientRect();
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;

    if (!stageRect.width || !stageRect.height || !imageWidth || !imageHeight) {
      return;
    }

    const fitScale = Math.min((stageRect.width * 0.92) / imageWidth, (stageRect.height * 0.92) / imageHeight, 1);
    const clampedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));

    scaleRef.current = clampedScale;
    pointRef.current = {
      x: (stageRect.width - imageWidth * clampedScale) / 2,
      y: (stageRect.height - imageHeight * clampedScale) / 2,
    };

    scheduleTransform();
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startRef.current = {
        x: event.clientX - pointRef.current.x,
        y: event.clientY - pointRef.current.y,
      };
      panningRef.current = true;
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!panningRef.current) return;
      event.preventDefault();
      pointRef.current = {
        x: event.clientX - startRef.current.x,
        y: event.clientY - startRef.current.y,
      };
      scheduleTransform();
    };

    const onMouseUp = () => {
      panningRef.current = false;
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const stageRect = stage.getBoundingClientRect();
      const mouseX = event.clientX - stageRect.left;
      const mouseY = event.clientY - stageRect.top;

      const wheel = event.deltaY < 0 ? 1 : -1;
      const zoomFactor = Math.exp(wheel * ZOOM_INTENSITY);
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scaleRef.current * zoomFactor));
      const scaleDelta = nextScale / scaleRef.current;

      pointRef.current = {
        x: mouseX - (mouseX - pointRef.current.x) * scaleDelta,
        y: mouseY - (mouseY - pointRef.current.y) * scaleDelta,
      };

      scaleRef.current = nextScale;
      scheduleTransform();
    };

    stage.addEventListener('mousedown', onMouseDown);
    stage.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      stage.removeEventListener('mousedown', onMouseDown);
      stage.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [scheduleTransform]);

  useEffect(() => {
    const trimmed = d2Code.trim();
    if (!trimmed) {
      const timeoutId = window.setTimeout(() => {
        setPngSrc('');
        setError('The selected D2 code is empty. Add D2 text to render the diagram.');
        setIsRendering(false);
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;
    const startRenderingTimeoutId = window.setTimeout(() => {
      setIsRendering(true);
    }, 0);

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/render-d2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ d2Code: trimmed }),
        });

        const payload = (await response.json()) as { svg?: string; error?: string };

        if (!response.ok || !payload.svg) {
          throw new Error(payload.error || 'Unable to render D2 diagram.');
        }

        const svgBlob = new Blob([payload.svg], { type: 'image/svg+xml;charset=utf-8' });
        const objectUrl = URL.createObjectURL(svgBlob);

        const image = new Image();
        image.decoding = 'async';

        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('Failed to decode SVG output from D2.'));
          image.src = objectUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Unable to initialize canvas context for PNG conversion.');
        }

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);

        const nextPngSrc = canvas.toDataURL('image/png');

        URL.revokeObjectURL(objectUrl);

        if (requestIdRef.current === currentRequestId) {
          setPngSrc(nextPngSrc);
          setError('');
          setIsRendering(false);
        }
      } catch (renderError) {
        const message = renderError instanceof Error ? renderError.message : String(renderError);
        if (requestIdRef.current === currentRequestId) {
          setError(message);
          setPngSrc('');
          setIsRendering(false);
        }
      }
    }, 280);

    return () => {
      window.clearTimeout(startRenderingTimeoutId);
      window.clearTimeout(timeoutId);
    };
  }, [d2Code, scheduleTransform]);

  return (
    <div className={`flex h-full flex-col transition-colors duration-300 ${isDeploying ? 'ring-1 ring-inset ring-orange-200' : ''}`}>
      <div className={`shrink-0 border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-300 ${isDeploying ? 'border-orange-200 bg-orange-50/90 text-orange-700' : 'border-slate-200 bg-white/80 text-slate-500'}`}>
        {isRendering ? 'Compiling latest diagram...' : error ? 'Render failed' : 'Compiled from latest D2 code'}
      </div>

      <div
        ref={stageRef}
        className={`relative min-h-[320px] flex-1 overflow-hidden p-4 cursor-grab active:cursor-grabbing transition-all duration-300 ${isDeploying ? 'bg-gradient-to-br from-orange-50 via-white to-orange-100' : 'bg-slate-100'}`}
        style={{
          backgroundImage:
            isDeploying
              ? 'linear-gradient(rgba(249,115,22,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(249,115,22,0.10) 1px, transparent 1px)'
              : 'linear-gradient(rgba(100,116,139,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(100,116,139,0.08) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      >
        {pngSrc ? (
          <div
            ref={layerRef}
            className={`absolute left-0 top-0 inline-flex items-center justify-center rounded-lg border p-4 shadow-2xl ${isDeploying ? 'border-orange-300 bg-white shadow-orange-200/50' : 'border-slate-300 bg-white'}`}
            style={{ transformOrigin: '0 0', willChange: 'transform' }}
          >
            <img
              ref={imageRef}
              src={pngSrc}
              alt="Generated D2 diagram"
              className={`block max-w-none select-none ${isDeploying ? 'animate-pulse [animation-duration:2.6s]' : ''}`}
              onLoad={resetAndFit}
              draggable={false}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className={`max-w-[640px] rounded-xl border px-5 py-4 text-sm shadow-lg ${isDeploying ? 'border-orange-200 bg-white text-orange-700' : 'border-slate-300 bg-white text-slate-600'}`}>
              {error || 'Write D2 code to generate the diagram preview.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
