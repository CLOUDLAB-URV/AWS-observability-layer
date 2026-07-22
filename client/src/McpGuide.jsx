// Usage guide for the Sigilum MCP, opened from the profile menu. Written for users (how to
// use it), not as an API reference. `onOpenConnect` opens the "Connect agent" modal so
// the token reference is one click away. `inModal` drops the panel chrome (its own surface and
// bottom border) for the pop-up card, which already provides both.

export default function McpGuide({ onOpenConnect, inModal = false }) {
    return (
        <div className={`mcp-guide ${inModal ? 'is-modal' : ''}`} role="region" aria-label="How to use Sigilum">
            <div className="guide-head">
                <h3>Using Sigilum</h3>
                <p className="guide-lede">
                    Connect the MCP once and your AWS work draws itself. Whenever your agent deploys
                    or changes something in AWS, it's reported for you and the live sigil here
                    stays in sync — you never run anything by hand.
                </p>
            </div>

            {/* Automatic */}
            <section className="guide-section">
                <h4 className="guide-section-title">It happens automatically</h4>
                <p>
                    With the MCP active, every time you deploy or modify something in AWS the agent
                    records it for you (it calls <code>push_sigil</code> behind the scenes) and
                    the sigil updates on its own. Just build your infrastructure as usual — the
                    picture keeps itself up to date.
                </p>
                <div className="guide-flow">
                    <span className="guide-flow-step">You deploy in AWS<br /><em>as usual</em></span>
                    <span className="guide-flow-arrow" aria-hidden="true">→</span>
                    <span className="guide-flow-step">Reported automatically<br /><em>no manual step</em></span>
                    <span className="guide-flow-arrow" aria-hidden="true">→</span>
                    <span className="guide-flow-step">Sigil updates here<br /><em>live</em></span>
                </div>
            </section>

            {/* One chat = one sigil */}
            <section className="guide-section">
                <h4 className="guide-section-title">One chat, one sigil</h4>
                <p>
                    Each new chat with your agent is its own sigil. The first time you deploy
                    something in a chat, a <strong>new sigil is created with its own id</strong>,
                    and it's <strong>named automatically</strong> based on what you built in that
                    first deployment (for example, “Two-tier web app”). You can rename it anytime
                    from <strong>Options</strong> in the toolbar above.
                </p>
                <p>
                    From then on, everything you do in that chat — add, change or remove resources —
                    is reflected in <strong>that same sigil</strong>. The context follows the chat:
                    the chat you're working in <em>is</em> the sigil you're editing. Start a new
                    chat and you start a fresh, independent sigil.
                </p>
            </section>

            {/* Switching sigils */}
            <section className="guide-section">
                <h4 className="guide-section-title">Switching to another sigil</h4>
                <p>
                    Want to keep working on something you deployed earlier, even from another chat?
                    Just <strong>ask the agent to load that sigil by name</strong> — for example,
                    <em> “load the sigil for the serverless API”</em>. It finds the closest match by
                    name (it doesn't need to be exact) and pulls that sigil's current state into
                    context, so everything you do next applies to it.
                </p>
                <p>
                    Not sure what you have? Ask the agent to <strong>list your sigils</strong> to
                    see everything saved under your account, then load the one you want by name.
                </p>
                <p className="guide-aside">
                    Behind the scenes the agent uses <code>list_sigils</code> to see what's available
                    and <code>load_sigil</code> to switch — you just talk to it in plain language.
                </p>
            </section>

            {/* Setup */}
            <section className="guide-section">
                <h4 className="guide-section-title">One-time setup</h4>
                <p>
                    For any of this to work, the MCP needs <strong>your personal token</strong> in its
                    configuration. Get it from{' '}
                    <button type="button" className="guide-inline-link" onClick={onOpenConnect}>
                        Connect agent
                    </button>{' '}
                    — generate a token there and add it to the MCP. Without it, nothing gets reported.
                </p>
            </section>
        </div>
    );
}
