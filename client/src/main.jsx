import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Auth from './Auth.jsx';
import ResetPassword from './ResetPassword.jsx';
import { loadFeatures } from './features.js';
import { loadSession } from './auth.js';
// Self-hosted elegant typefaces (bundled by Vite — no external CDN). Geist for the UI,
// Geist Mono for logs/diagram. The single dark theme references these in styles.css.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
// dockview base styles (docking layout in the Agent (MCP) view). Imported before our own
// stylesheet so our `.viz-dock` theme overrides in styles.css win on equal specificity.
import 'dockview-core/dist/styles/dockview.css';
import './styles.css';

// The password-reset link (`/reset?token=…`) is a standalone page — it needs no session and no
// feature/config fetch, so render it immediately and skip the rest.
const resetToken = window.location.pathname === '/reset'
    ? new URLSearchParams(window.location.search).get('token')
    : null;

if (resetToken) {
    createRoot(document.getElementById('root')).render(
        <React.StrictMode>
            <ResetPassword token={resetToken} />
        </React.StrictMode>
    );
} else {
    // Before rendering, fetch which modes are available and the current session. If auth is on and
    // nobody is logged in, show the login screen; otherwise render the app for the resolved user.
    Promise.all([loadFeatures(), loadSession()]).then(([features, session]) => {
        const root = createRoot(document.getElementById('root'));
        const needsLogin = session.authEnabled && !session.user;
        root.render(
            <React.StrictMode>
                {needsLogin ? <Auth /> : <App features={features} user={session.user} />}
            </React.StrictMode>
        );
    });
}
