import Diagram from '../Diagram.jsx';
import { useDeployed } from '../DeployedContext.js';

// Central, always-present panel: the live architecture canvas. When no diagram is
// available it shows the same empty states the deployed view used to render inline
// (pick a chat / no deployed state yet). The <Diagram> refits itself via a
// ResizeObserver, so docking/resizing this panel keeps it centered automatically.
export default function DiagramPanel() {
    const { svg, renderError, resources, selectedResource, setSelectedResource, chatId, chatsCount } =
        useDeployed();

    return (
        <div className="dv-diagram">
            {svg ? (
                <Diagram
                    svg={svg}
                    renderError={renderError}
                    resources={resources}
                    selectedId={selectedResource?.id}
                    onSelectResource={setSelectedResource}
                />
            ) : (
                <div className="diagram-empty">
                    {chatId ? (
                        <>No deployed state yet for this chat. Deploy with your agent (it calls{' '}
                        <code>push_deployment</code>) to see the live diagram here.</>
                    ) : (
                        <div className="diagram-empty-hint">
                            <span className="diagram-empty-icon" aria-hidden="true">◇</span>
                            <span className="diagram-empty-title">Select a chat to view its diagram</span>
                            <span>
                                {chatsCount
                                    ? 'Pick a deployment from the Chat menu above.'
                                    : 'Connect your agent and ask it to deploy — a chat will appear here.'}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
