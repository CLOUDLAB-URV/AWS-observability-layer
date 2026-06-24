import { useCallback, useRef, useState } from 'react';

const INITIAL_WIDTH = 380;
const MIN_WIDTH = 260;
const MAX_WIDTH = 640;

export function useChatPanel() {
    const [collapsed, setCollapsed] = useState(false);
    const [floating, setFloating] = useState(false);
    const [maximized, setMaximized] = useState(false);
    const [width, setWidth] = useState(INITIAL_WIDTH);
    const [floatPos, setFloatPos] = useState({ x: 20, y: 68 });
    const [floatSize] = useState({ w: INITIAL_WIDTH, h: 520 });

    const layoutRef = useRef(null);
    const chatRef = useRef(null);
    const widthRef = useRef(INITIAL_WIDTH);

    const toggleCollapse = useCallback(() => {
        setCollapsed((c) => {
            if (!c) {
                setFloating(false);
                setMaximized(false);
            }
            return !c;
        });
    }, []);

    const toggleFloat = useCallback(() => {
        setFloating((f) => !f);
        setMaximized(false);
        setCollapsed(false);
    }, []);

    const toggleMaximize = useCallback(() => {
        setMaximized((m) => !m);
        setFloating(false);
        setCollapsed(false);
    }, []);

    // Resize handle: mutates CSS custom property directly (no React re-render per frame)
    const startResize = useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = widthRef.current;
        const layout = layoutRef.current;
        if (!layout) return;

        const onMove = (ev) => {
            const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + ev.clientX - startX));
            layout.style.setProperty('--chat-width', `${newWidth}px`);
        };
        const onUp = () => {
            const raw = layout.style.getPropertyValue('--chat-width');
            const finalWidth = raw ? parseInt(raw, 10) : startWidth;
            widthRef.current = finalWidth;
            setWidth(finalWidth);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    // Float drag: mutates CSS custom properties directly (no React re-render per frame)
    const startFloatDrag = useCallback((e) => {
        if (!floating) return;
        e.preventDefault();
        const chat = chatRef.current;
        if (!chat) return;

        const rect = chat.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const chatW = rect.width;
        const chatH = rect.height;

        const onMove = (ev) => {
            let x = ev.clientX - offsetX;
            let y = ev.clientY - offsetY;
            // Edge snapping
            if (x < 40) x = 0;
            else if (x + chatW > window.innerWidth - 40) x = window.innerWidth - chatW;
            y = Math.max(0, Math.min(window.innerHeight - chatH, y));
            chat.style.setProperty('--chat-float-x', `${x}px`);
            chat.style.setProperty('--chat-float-y', `${y}px`);
        };
        const onUp = () => {
            const x = parseInt(chat.style.getPropertyValue('--chat-float-x') || floatPos.x, 10);
            const y = parseInt(chat.style.getPropertyValue('--chat-float-y') || floatPos.y, 10);
            setFloatPos({ x, y });
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [floating, floatPos]);

    return {
        collapsed, floating, maximized, width, floatPos, floatSize,
        layoutRef, chatRef,
        toggleCollapse, toggleFloat, toggleMaximize,
        startResize, startFloatDrag,
    };
}
