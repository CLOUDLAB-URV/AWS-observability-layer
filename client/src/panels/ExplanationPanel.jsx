import { useDeployed } from '../DeployedContext.js';
import { renderMarkdown } from '../markdown.jsx';

// On-demand, part-by-part Markdown explanation of the whole diagram. Generation is a
// separate backend call that evolves the previous explanation (incremental). The panel
// only ever shows the saved payload; the CTA triggers a (re)generation.
export default function ExplanationPanel(props) {
    const { explanation, explaining, generateExplanation, chatId } = useDeployed();

    return (
        <div className="dv-pane explanation-panel">
            <div className="rd-header">
                <h2>Sigil explanation</h2>
                <button
                    type="button"
                    className="rd-close"
                    onClick={() => props.api.close()}
                    aria-label="Close explanation"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                </button>
            </div>
            <div className="explanation-body">
                {!chatId ? (
                    <div className="explain-empty"><p>Select a sigil to explain it.</p></div>
                ) : explanation?.markdown ? (
                    <>
                        {explanation.outdated && (
                            <div className="explain-stale">
                                <span>The sigil changed since this was written.</span>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={generateExplanation}
                                    disabled={explaining}
                                >
                                    {explaining ? 'Updating…' : 'Update explanation'}
                                </button>
                            </div>
                        )}
                        <div className="md-body">{renderMarkdown(explanation.markdown)}</div>
                    </>
                ) : (
                    <div className="explain-empty">
                        <p>No explanation yet for this sigil.</p>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={generateExplanation}
                            disabled={explaining}
                        >
                            {explaining ? 'Generating…' : 'Generate explanation'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
