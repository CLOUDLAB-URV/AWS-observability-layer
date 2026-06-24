import { useEffect, useState } from 'react';

export function useDarkMode() {
    const [isDark, setIsDark] = useState(() => {
        const stored = localStorage.getItem('theme');
        if (stored) return stored === 'dark';
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    }, [isDark]);

    // Sync with system preference only when user hasn't manually set a theme
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e) => {
            if (!localStorage.getItem('theme')) setIsDark(e.matches);
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    const toggle = () => {
        setIsDark((d) => {
            const next = !d;
            localStorage.setItem('theme', next ? 'dark' : 'light');
            return next;
        });
    };

    return [isDark, toggle];
}
