import { createContext, useContext } from 'react';

// Shared state + handlers for the Agent (MCP) view, consumed by the dockview panels.
// dockview renders each panel itself (outside the normal React tree), so panels can't
// receive props from DeployedState — they read everything they need from this context
// instead. DeployedState owns all the state/logic and wraps the panels in the Provider.
export const DeployedContext = createContext(null);

export function useDeployed() {
    return useContext(DeployedContext);
}
