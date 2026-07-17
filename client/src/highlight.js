// Tiny wrapper over highlight.js core. We register only the languages a Lambda handler /
// EC2 user-data / Step Functions definition is likely to use, so the bundle stays small
// (the full highlight.js auto-bundle ships ~190 languages). Token colors live in styles.css
// (`.hljs-*`), tuned to the app's dark palette — no external theme CSS is imported.

import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';

hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml); // also covers html

// Normalize a few common language hints to the registered names / built-in aliases.
const LANGUAGE_ALIASES = {
    py: 'python',
    js: 'javascript',
    node: 'javascript',
    nodejs: 'javascript',
    ts: 'typescript',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    html: 'xml'
};

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Return highlighted HTML for `content`. Falls back to escaped plain text when the language
// is unknown/absent or highlighting throws — the caller drops it into a <pre> via
// dangerouslySetInnerHTML, so escaping is mandatory on every path.
export function highlightCode(content, language) {
    const raw = String(content ?? '');
    const hint = String(language ?? '').trim().toLowerCase();
    const lang = LANGUAGE_ALIASES[hint] || hint;
    if (lang && hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
        } catch {
            // fall through to plain text
        }
    }
    return escapeHtml(raw);
}
