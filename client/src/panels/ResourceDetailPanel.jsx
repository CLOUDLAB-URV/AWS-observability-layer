import ResourceDetail from '../ResourceDetail.jsx';
import { useDeployed } from '../DeployedContext.js';

// Data-driven panel: opened by DeployedState whenever a diagram node is clicked
// (selectedResource set) and closed when the selection clears. Closing the panel's
// tab also clears the selection (DeployedState watches the layout for its removal).
export default function ResourceDetailPanel() {
    const { selectedResource, setSelectedResource } = useDeployed();
    if (!selectedResource) {
        return <div className="dv-pane dv-pane-empty">No resource selected.</div>;
    }
    // ResourceDetail reads the per-resource `deployed` flag off the resource itself
    // (the backend backfills it), so no sigil-level prop is needed here.
    return (
        <div className="dv-pane">
            <ResourceDetail resource={selectedResource} onClose={() => setSelectedResource(null)} />
        </div>
    );
}
