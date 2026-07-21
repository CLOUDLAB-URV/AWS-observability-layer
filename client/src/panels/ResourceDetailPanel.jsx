import ResourceDetail from '../ResourceDetail.jsx';
import { useDeployed } from '../DeployedContext.js';

// A resource detail tab, bound to one resource via its params.resourceId. Every service opens as
// one of these (there is no special shared tab): a plain click retargets the last-used tab to a new
// resource (its params change in place), and a Shift-click opens another. It reads its resource from
// the live inventory so backend pushes keep it fresh, and closing it removes just that tab.
export default function ResourceDetailPanel(props) {
    const { resources, openCode } = useDeployed();
    const resourceId = props?.params?.resourceId ?? null;
    const resource = (resources || []).find((r) => r.id === resourceId) || null;

    if (!resource) {
        // A tab restored before its inventory has loaded shows a neutral loading state; once
        // resources arrive it either binds or reports the resource is gone.
        const msg = (resources && resources.length)
            ? 'This resource is no longer in the sigil.'
            : 'Loading resource…';
        return <div className="dv-pane dv-pane-empty">{msg}</div>;
    }

    return (
        <div className="dv-pane">
            <ResourceDetail
                resource={resource}
                onClose={() => props.api.close()}
                onViewCode={(file) => openCode(resource, file)}
            />
        </div>
    );
}
