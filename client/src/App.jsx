import { useState } from 'react';
import DeployedState from './DeployedState.jsx';
import UserMenu from './UserMenu.jsx';
import AdminPanel from './admin/AdminPanel.jsx';
import Logo from './Logo.jsx';

// Top-level shell. The app has a single mode — Sigils (the MCP-fed visualizer) — plus the
// admin console, reachable only from the profile menu. `features.agent` comes from the
// backend at runtime (GET /api/config, fetched in main.jsx); when it's off the backend also
// gates the API, so the UI shows an inert empty state. `user` is the logged-in account (or
// the synthetic "dev" user when auth is disabled locally).
export default function App({ features, user, onUserChange, share = null }) {
    const AGENT_ENABLED = features.agent;

    // 'deployed' | 'admin'. Admin is only reachable from the profile menu.
    const [view, setView] = useState('deployed');
    const openAdmin = () => setView('admin');

    // Sigils view: DeployedState owns the whole screen, including the single top bar
    // (logo · sigil selector · panel buttons · profile), because the bar's controls act
    // on its state (selection, panels, layout zones).
    if (AGENT_ENABLED && view === 'deployed') {
        return (
            <div className="app">
                <DeployedState user={user} onUserChange={onUserChange} onOpenAdmin={openAdmin} share={share} />
            </div>
        );
    }

    // Admin view (and the "disabled by config" empty state): a minimal bar with just the
    // brand and the profile menu.
    return (
        <div className="app">
            <header className="topbar" role="banner">
                <div className="topbar-left">
                    <div className="brand">
                        <Logo size={22} className="brand-mark" />
                        <h1>Sigilum</h1>
                    </div>
                </div>
                <div className="topbar-center" />
                <div className="topbar-right">
                    {user && <UserMenu user={user} onUserChange={onUserChange} onOpenAdmin={openAdmin} />}
                </div>
            </header>
            <main id="main-content" className="layout" role="main">
                {view === 'admin' ? (
                    <AdminPanel user={user} onBack={() => setView('deployed')} />
                ) : (
                    <div className="diagram-empty">
                        <div className="diagram-empty-hint">
                            <span className="diagram-empty-icon" aria-hidden="true">◇</span>
                            <span className="diagram-empty-title">Sigilum is disabled</span>
                            <span>
                                Enable it via <code>AGENT_ENABLED</code> in the deployment's{' '}
                                <code>.env</code> (default is enabled).
                            </span>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
