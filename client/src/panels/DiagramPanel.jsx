import Diagram from '../Diagram.jsx';
import { useDeployed } from '../DeployedContext.js';

// Central, always-present panel: the live architecture canvas. When no diagram is
// available it shows the same empty states the deployed view used to render inline
// (pick a chat / no deployed state yet). The <Diagram> refits itself via a
// ResizeObserver, so docking/resizing this panel keeps it centered automatically.
export default function DiagramPanel() {
    const { svg, renderError, resources, selectedResource, setSelectedResource, chatId, chatsCount, deployed } =
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
                    deployed={deployed}
                />
            ) : (
                <div className="diagram-empty">
                    {chatId ? (
                        <>Nothing drawn on this sigil yet. Deploy with your agent (it calls{' '}
                        <code>push_sigil</code>) to see the live sigil here.</>
                    ) : (
                        <div className="diagram-empty-hint">
                            <span className="diagram-empty-icon" aria-hidden="true">◇</span>
                            <span className="diagram-empty-title">Select a sigil to view it</span>
                            <span>
                                {chatsCount
                                    ? 'Pick one from the Sigil menu above.'
                                    : 'Connect your agent and ask it to deploy — a sigil will appear here.'}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
