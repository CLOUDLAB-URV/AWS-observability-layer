import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { loadFeatures } from './features.js';
import './styles.css';

// Fetch which modes are available from the backend before rendering, so the UI matches the
// deploy's environment with no build-time flags baked in.
loadFeatures().then((features) => {
    createRoot(document.getElementById('root')).render(
        <React.StrictMode>
            <App features={features} />
        </React.StrictMode>
    );
});
