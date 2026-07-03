import McpGuide from '../McpGuide.jsx';
import { useDeployed } from '../DeployedContext.js';

// Usage guide for the visualizer MCP. Its inline "connect" link opens the
// Connect-agent panel (routed through the context so the two panels can coexist).
export default function GuidePanel() {
    const { openConnectAgent } = useDeployed();
    return (
        <div className="dv-pane">
            <McpGuide onOpenConnect={openConnectAgent} />
        </div>
    );
}
