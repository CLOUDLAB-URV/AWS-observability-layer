import DevPanel from '../DevPanel.jsx';

// The opencode / Claude Code embed as a dockable panel (Agent (MCP) view). `embedded`
// tells DevPanel to fill the pane and drop its own drawer chrome — dockview owns the
// position, size and close instead, so the whole thing is now movable.
export default function DevToolsPanel() {
    return <DevPanel embedded />;
}
