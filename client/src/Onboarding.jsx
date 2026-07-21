import { useDeployed } from './DeployedContext.js';

// First-run guide, shown on the empty canvas until the user has BOTH a token and a first sigil.
// Nothing works until the MCP can talk to this account, so the three things that have to happen are
// spelled out and — where they're detectable — tick themselves off:
//   1. a token exists            → /api/tokens is non-empty (or local dev's fixed token)
//   2. the command is pasted     → NOT detectable; stays neutral so the card never looks stuck
//   3. the agent deployed once   → the user's first sigil appears (polled in DeployedState)
function Step({ state, n, title, children }) {
    return (
        <li className={`onb-step is-${state}`}>
            <span className="onb-step-mark" aria-hidden="true">{state === 'done' ? '✓' : n}</span>
            <div className="onb-step-body">
                <span className="onb-step-title">{title}</span>
                <span className="onb-step-detail">{children}</span>
            </div>
        </li>
    );
}

export default function Onboarding() {
    const { onboarding, openConnectAgent } = useDeployed();
    if (!onboarding) return null;
    const { hasToken, hasSigil } = onboarding;

    return (
        <div className="onboarding" role="region" aria-label="Getting started with Sigilum">
            <span className="onb-icon" aria-hidden="true">◇</span>
            <h2 className="onb-title">Connect your agent to get started</h2>
            <p className="onb-lede">
                Connect the MCP once and your AWS work draws itself: whenever your agent deploys or
                changes something, it's reported for you and the sigil appears here — you never run
                anything by hand.
            </p>

            <ol className="onb-steps">
                <Step state={hasToken ? 'done' : 'current'} n="1" title="Generate your token">
                    {hasToken
                        ? 'Done — your account has a token.'
                        : 'The MCP needs a personal token to report into your account.'}
                </Step>
                <Step state={hasToken ? 'current' : 'pending'} n="2" title="Add it to your agent">
                    Copy the ready-made command from <strong>Connect agent</strong> and paste it into
                    your terminal — the token is already included.
                </Step>
                <Step state={hasSigil ? 'done' : 'pending'} n="3" title="Deploy something in AWS">
                    {hasSigil
                        ? 'Done — your first sigil arrived.'
                        : hasToken
                            ? <>Just build as usual and ask your agent to deploy.{' '}
                                <span className="onb-waiting">Waiting for your first deployment…</span></>
                            : 'Just build as usual — the first deployment creates your sigil.'}
                </Step>
            </ol>

            <button type="button" className="btn btn-primary onb-cta" onClick={openConnectAgent}>
                {hasToken ? 'Open Connect agent' : 'Connect agent'}
            </button>
        </div>
    );
}
