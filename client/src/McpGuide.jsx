// Usage guide for the diagram-state-visualizer MCP, shown in the Agent (MCP) view.
// Written for users (how to use it), not as an API reference. `onOpenConnect` opens the
// "Connect agent" panel so the token reference is one click away.

export default function McpGuide({ onOpenConnect }) {
    return (
        <div className="mcp-guide" role="region" aria-label="How to use the visualizer">
            <div className="guide-head">
                <h3>Using the visualizer</h3>
                <p className="guide-lede">
                    Connect the MCP once and your AWS work draws itself. Whenever your agent deploys
                    or changes something in AWS, it's reported for you and the live diagram here
                    stays in sync — you never run anything by hand.
                </p>
            </div>

            {/* Automatic */}
            <section className="guide-section">
                <h4 className="guide-section-title">It happens automatically</h4>
                <p>
                    With the MCP active, every time you deploy or modify something in AWS the agent
                    records it for you (it calls <code>push_deployment</code> behind the scenes) and
                    the diagram updates on its own. Just build your infrastructure as usual — the
                    picture keeps itself up to date.
                </p>
                <div className="guide-flow">
                    <span className="guide-flow-step">You deploy in AWS<br /><em>as usual</em></span>
                    <span className="guide-flow-arrow" aria-hidden="true">→</span>
                    <span className="guide-flow-step">Reported automatically<br /><em>no manual step</em></span>
                    <span className="guide-flow-arrow" aria-hidden="true">→</span>
                    <span className="guide-flow-step">Diagram updates here<br /><em>live</em></span>
                </div>
            </section>

            {/* One chat = one diagram */}
            <section className="guide-section">
                <h4 className="guide-section-title">One chat, one diagram</h4>
                <p>
                    Each new chat is its own diagram. The first time you deploy something in a chat,
                    a <strong>new diagram is created with its own id</strong>, and it's
                    <strong> named automatically</strong> based on what you built in that first
                    deployment (for example, “Two-tier web app”). You can rename it anytime from
                    <strong> Details</strong> in the toolbar above.
                </p>
                <p>
                    From then on, everything you do in that chat — add, change or remove resources —
                    is reflected in <strong>that same diagram</strong>. The context follows the chat:
                    the chat you're working in <em>is</em> the diagram you're editing. Start a new
                    chat and you start a fresh, independent diagram.
                </p>
            </section>

            {/* Switching diagrams */}
            <section className="guide-section">
                <h4 className="guide-section-title">Switching to another diagram</h4>
                <p>
                    Want to keep working on something you deployed earlier, even from another chat?
                    Just <strong>ask the agent to load that diagram by name</strong> — for example,
                    <em> “load the diagram for the serverless API”</em>. It finds the closest match by
                    name (it doesn't need to be exact) and pulls that diagram's current state into
                    context, so everything you do next applies to it.
                </p>
                <p>
                    Not sure what you have? Ask the agent to <strong>list your diagrams</strong> to
                    see everything saved under your account, then load the one you want by name.
                </p>
                <p className="guide-aside">
                    Behind the scenes the agent uses <code>list_chats</code> to see what's available
                    and <code>load_chat</code> to switch — you just talk to it in plain language.
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
