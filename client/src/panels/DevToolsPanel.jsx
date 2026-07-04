import DevPanel from '../DevPanel.jsx';

// The opencode embed as a dockable panel (Sigils view). `embedded` tells DevPanel to fill
// the pane and drop its own drawer chrome — dockview owns the position, size and close
// instead, so the whole thing is now movable.
export default function DevToolsPanel() {
    return <DevPanel embedded />;
}
