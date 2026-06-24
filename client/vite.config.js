import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            // Matches both /ws (design) and /ws-visualizer (deployed state).
            '/ws': {
                target: 'ws://127.0.0.1:3001',
                ws: true
            },
            '/api': {
                target: 'http://127.0.0.1:3001'
            }
        }
    }
});
