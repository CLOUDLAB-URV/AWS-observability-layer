import { useDeployed } from '../DeployedContext.js';

// "Connect your agent": token management (step 1) + ready-to-paste MCP config for the
// chosen agent — opencode or Claude Code (step 2) + how it works (step 3). The agent picker
// in step 2 drives the command block and the "Remove the MCP later" instructions. Note the
// opencode iframe panel elsewhere in the dock is opencode-only; this picker is just about
// which MCP setup instructions to show (Claude Code is driven from the user's terminal).
export default function ConnectAgentPanel() {
    const {
        dev, devToken, visualizerUrl, tokens, tokenError, newToken, TOKEN_LIMIT, TOKEN_PLACEHOLDER,
        generateToken, revokeToken, confirmRevoke, setConfirmRevoke, formatDate, copy, copied,
        agent, setAgent, addCommand, claudeRemoveCommand, opencodeRemoveCommand
    } = useDeployed();

    return (
        <div className="dv-pane viz-settings" role="region" aria-label="Connect your agent">
            <div className="viz-settings-head">
                <h3>Connect your agent</h3>
                <p className="viz-settings-sub">
                    Register the <code>sigilum</code> MCP in your agent, then ask your agent to
                    deploy — after each change it reports what it created or removed and a live
                    sigil appears here. Each chat gets its own sigil. No AWS MCP needed; your agent
                    deploys with its own tools and just reports the result.
                </p>
            </div>

            <ol className="viz-steps">
                <li className="viz-step">
                    <div className="viz-step-num">1</div>
                    <div className="viz-step-body">
                        <div className="viz-step-title">
                            {dev ? 'Local dev token' : 'Your API tokens'}
                            {!dev && <span className="token-count">{tokens.length}/{TOKEN_LIMIT}</span>}
                        </div>

                        {dev ? (
                            <>
                                <p className="viz-step-hint">
                                    In local dev there's no login and no token generation: the MCP authenticates
                                    with this fixed token, set via the <code>DEV_VISUALIZER_TOKEN</code> env var.
                                    It resolves to your local dev profile (data is wiped when the server stops).
                                </p>
                                <div className="token-chip">
                                    <code>{devToken}</code>
                                    <button
                                        type="button"
                                        className={`copy-btn ${copied === 'devtok' ? 'is-copied' : ''}`}
                                        onClick={() => copy(devToken, 'devtok')}
                                    >
                                        {copied === 'devtok' ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                            </>
                        ) : (
                        <>
                        <p className="viz-step-hint">
                            A token authenticates your agent's pushes. Each token is shown in full only
                            once, right after you generate it — copy it then. You can hold up to{' '}
                            {TOKEN_LIMIT} tokens.
                        </p>

                        {tokens.length > 0 && (
                            <ul className="token-list">
                                {tokens.map((t) => (
                                    <li key={t.id} className="token-row">
                                        <code className="token-row-preview">{t.tokenPreview}</code>
                                        <span className="token-row-date">{formatDate(t.createdAt)}</span>
                                        {confirmRevoke === t.id ? (
                                            <span className="token-row-confirm">
                                                <span>Revoke?</span>
                                                <button type="button" className="link-btn token-danger" onClick={() => revokeToken(t.id)}>Revoke</button>
                                                <button type="button" className="link-btn" onClick={() => setConfirmRevoke('')}>Cancel</button>
                                            </span>
                                        ) : (
                                            <button type="button" className="link-btn" onClick={() => setConfirmRevoke(t.id)}>Revoke</button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <button
                            className="viz-primary-btn"
                            onClick={generateToken}
                            disabled={tokens.length >= TOKEN_LIMIT}
                        >
                            {tokens.length === 0 ? 'Generate token' : 'Generate another'}
                        </button>
                        {tokens.length >= TOKEN_LIMIT && (
                            <p className="token-hint">Limit reached ({TOKEN_LIMIT}). Revoke one to add a new token.</p>
                        )}
                        {tokenError && <p className="token-hint token-danger">{tokenError}</p>}

                        {newToken && (
                            <div className="token-new">
                                <div className="token-new-title">New token — copy it now. It won't be shown again.</div>
                                <div className="token-chip">
                                    <code>{newToken}</code>
                                    <button
                                        type="button"
                                        className={`copy-btn ${copied === 'tok' ? 'is-copied' : ''}`}
                                        onClick={() => copy(newToken, 'tok')}
                                    >
                                        {copied === 'tok' ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                            </div>
                        )}
                        </>
                        )}
                    </div>
                </li>

                <li className="viz-step">
                    <div className="viz-step-num">2</div>
                    <div className="viz-step-body">
                        <div className="viz-step-title viz-step-title-row">
                            <span>Add the MCP to your agent</span>
                            <select
                                className="agent-select"
                                value={agent}
                                onChange={(e) => setAgent(e.target.value)}
                                aria-label="Choose your agent"
                            >
                                <option value="opencode">opencode</option>
                                <option value="claude">Claude Code</option>
                            </select>
                        </div>
                        {agent === 'opencode' ? (
                            dev ? (
                                <>
                                    <p className="viz-step-hint">
                                        A ready-to-paste config for a separate <code>-local</code> MCP pointing at
                                        your local backend (<code>{visualizerUrl}</code>), so it coexists with your
                                        hosted one. The fixed dev token <code>{devToken}</code> is already included.
                                    </p>
                                    <div className="cmd-label">
                                        opencode <span className="cmd-label-sub">— add under <code>mcp</code> in <code>~/.config/opencode/opencode.json</code></span>
                                    </div>
                                </>
                            ) : newToken ? (
                                <p className="viz-step-hint">
                                    Paste this in your terminal — it installs opencode if needed and writes the
                                    MCP into <code>~/.config/opencode/opencode.json</code> for you.{' '}
                                    <strong>Your new token is already included.</strong> Re-running it later only
                                    refreshes the token.
                                </p>
                            ) : (
                                <p className="viz-step-hint">
                                    Paste this in your terminal — it installs opencode if needed and writes the
                                    MCP config for you. Replace <code>{TOKEN_PLACEHOLDER}</code> with your token
                                    (shown once when generated; if you don't have it,{' '}
                                    <strong>generate another above</strong>, up to {TOKEN_LIMIT}).
                                </p>
                            )
                        ) : (
                            dev ? (
                                <p className="viz-step-hint">
                                    Registers a separate <code>-local</code> MCP pointing at your local backend
                                    (<code>{visualizerUrl}</code>) at user scope, so it coexists with your hosted
                                    one. The fixed dev token <code>{devToken}</code> is already included.
                                </p>
                            ) : newToken ? (
                                <p className="viz-step-hint">
                                    Paste the whole command in your terminal. User scope = loaded in every
                                    session on this machine. <strong>Your new token is already included</strong>{' '}
                                    in the command below.
                                </p>
                            ) : (
                                <p className="viz-step-hint">
                                    Paste the command in your terminal (user scope = loaded in every session on
                                    this machine). Replace <code>{TOKEN_PLACEHOLDER}</code> with your token —
                                    it's only shown once when generated, so if you don't have it,{' '}
                                    <strong>generate another above</strong> (up to {TOKEN_LIMIT}).
                                </p>
                            )
                        )}
                        <div className="cmd-block">
                            <button
                                type="button"
                                className={`copy-btn ${copied === 'add' ? 'is-copied' : ''}`}
                                onClick={() => copy(addCommand, 'add')}
                            >
                                {copied === 'add' ? 'Copied' : 'Copy'}
                            </button>
                            <pre className="mcp-snippet">{addCommand}</pre>
                        </div>
                    </div>
                </li>

                <li className="viz-step">
                    <div className="viz-step-num">3</div>
                    <div className="viz-step-body">
                        <div className="viz-step-title">Deploy &amp; visualize</div>
                        <p className="viz-step-hint">
                            Ask your agent to deploy — after each change it calls{' '}
                            <code>push_sigil</code> with just what changed and the sigil updates
                            here. To resume an earlier sigil, your agent runs <code>list_sigils</code> and
                            then <code>load_sigil</code> with the closest sigil name (matched by
                            proximity); or pin one via the <code>SIGILUM_SIGIL_ID</code> env var.
                        </p>
                    </div>
                </li>
            </ol>

            <details className="viz-remove">
                <summary>Remove the MCP later</summary>
                {agent === 'opencode' ? (
                    dev ? (
                        <p className="viz-step-hint">
                            Delete the <code>sigilum-local</code> entry under <code>mcp</code> in{' '}
                            <code>~/.config/opencode/opencode.json</code>.
                        </p>
                    ) : (
                        <>
                            <p className="viz-step-hint">
                                Paste this in your terminal — it idempotently checks your opencode
                                config and removes the <code>sigilum</code> entry if it's there.
                            </p>
                            <div className="cmd-block">
                                <button
                                    type="button"
                                    className={`copy-btn ${copied === 'rm-oc' ? 'is-copied' : ''}`}
                                    onClick={() => copy(opencodeRemoveCommand, 'rm-oc')}
                                >
                                    {copied === 'rm-oc' ? 'Copied' : 'Copy'}
                                </button>
                                <pre className="mcp-snippet">{opencodeRemoveCommand}</pre>
                            </div>
                        </>
                    )
                ) : (
                    <div className="cmd-block">
                        <button
                            type="button"
                            className={`copy-btn ${copied === 'rm' ? 'is-copied' : ''}`}
                            onClick={() => copy(claudeRemoveCommand, 'rm')}
                        >
                            {copied === 'rm' ? 'Copied' : 'Copy'}
                        </button>
                        <pre className="mcp-snippet">{claudeRemoveCommand}</pre>
                    </div>
                )}
            </details>
        </div>
    );
}
