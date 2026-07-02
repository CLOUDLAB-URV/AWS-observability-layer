// Tiny shared Markdown renderer used by the chat bubbles and the diagram-explanation
// panel. Deliberately minimal (no dependency): supports `##`/`###` headings, `-`/`*`/`•`
// bullet lists, `1.` numbered lists, blank-line spacing, plus inline `**bold**` and
// `` `code` ``. Anything else renders as plain text.

export function inlineMarkdown(text) {
    const parts = [];
    const re = /(\*\*(.+?)\*\*|`([^`]+)`)/g;
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        if (match[2] !== undefined) parts.push(<strong key={match.index}>{match[2]}</strong>);
        else if (match[3] !== undefined) parts.push(<code key={match.index} className="md-code">{match[3]}</code>);
        last = re.lastIndex;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

export function renderMarkdown(text) {
    const nodes = [];
    const lines = String(text ?? '').split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Heading (## / ###) — level from the number of leading hashes.
        const heading = /^(#{2,4})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length; // 2..4
            const Tag = `h${level}`;
            nodes.push(
                <Tag key={nodes.length} className="md-heading">{inlineMarkdown(heading[2])}</Tag>
            );
            i++;
            continue;
        }
        // Bullet list
        if (/^[-*•]\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^[-*•]\s/.test(lines[i])) {
                items.push(lines[i].replace(/^[-*•]\s/, ''));
                i++;
            }
            nodes.push(
                <ul key={nodes.length} className="md-list">
                    {items.map((item, j) => <li key={j}>{inlineMarkdown(item)}</li>)}
                </ul>
            );
            continue;
        }
        // Numbered list
        if (/^\d+\.\s/.test(line)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
                items.push(lines[i].replace(/^\d+\.\s/, ''));
                i++;
            }
            nodes.push(
                <ol key={nodes.length} className="md-list">
                    {items.map((item, j) => <li key={j}>{inlineMarkdown(item)}</li>)}
                </ol>
            );
            continue;
        }
        // Empty line → spacing
        if (line.trim() === '') {
            if (nodes.length > 0) nodes.push(<br key={nodes.length} />);
            i++;
            continue;
        }
        nodes.push(<span key={nodes.length}>{inlineMarkdown(line)}{i < lines.length - 1 ? '\n' : ''}</span>);
        i++;
    }
    return nodes;
}
