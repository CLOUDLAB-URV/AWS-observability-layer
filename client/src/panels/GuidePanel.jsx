import McpGuide from '../McpGuide.jsx';
import { useDeployed } from '../DeployedContext.js';

// Usage guide for the visualizer MCP. Its inline "connect" link opens the
// Connect-agent modal (opened through the context so the CTA and the profile-menu entry share it).
export default function GuidePanel() {
    const { openConnectAgent } = useDeployed();
    return (
        <div className="dv-pane">
            <McpGuide onOpenConnect={openConnectAgent} />
        </div>
    );
}
