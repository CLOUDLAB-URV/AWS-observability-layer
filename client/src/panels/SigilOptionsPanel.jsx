import SigilOptions from '../SigilOptions.jsx';
import { useDeployed } from '../DeployedContext.js';

// The "Sigil options" side panel — the settings/display/delete controls for the current sigil,
// docked (right zone by default) like the resource/ask/code panels rather than a centered modal.
// Mirrors ResourceDetailPanel: a thin dockview wrapper that pulls state from context and renders
// the content inside a .dv-pane, closing via the dockview api.
export default function SigilOptionsPanel(props) {
    const { selectedChat } = useDeployed();

    if (!selectedChat) {
        return <div className="dv-pane dv-pane-empty">Select a sigil to see its options.</div>;
    }

    return (
        <div className="dv-pane">
            <SigilOptions onClose={() => props.api.close()} />
        </div>
    );
}
