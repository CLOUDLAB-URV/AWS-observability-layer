import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Login from './Login.jsx';
import { loadFeatures } from './features.js';
import { loadSession } from './auth.js';
// Self-hosted elegant typefaces (bundled by Vite — no external CDN). Geist for the UI,
// Geist Mono for logs/diagram. The single dark theme references these in styles.css.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

// Before rendering, fetch which modes are available and the current session. If auth is on and
// nobody is logged in, show the login screen; otherwise render the app for the resolved user.
Promise.all([loadFeatures(), loadSession()]).then(([features, session]) => {
    const root = createRoot(document.getElementById('root'));
    const needsLogin = session.authEnabled && !session.user;
    root.render(
        <React.StrictMode>
            {needsLogin ? <Login /> : <App features={features} user={session.user} />}
        </React.StrictMode>
    );
});
