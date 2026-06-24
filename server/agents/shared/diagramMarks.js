'use strict';

// Shared D2 "deploy failure" marking helpers, used by the reconciler (to mark
// not-deployed resources red) and the aws agent (to strip those marks before a
// retry so it sees the user's clean design). Keeping the format in one place
// guarantees strip() is the exact inverse of the annotation appended by mark().

const FAILURE_MARKER = '# ── deploy failures (not created) ──';
const LABEL_SUFFIX = '\\n✗ NOT DEPLOYED'; // literal backslash-n in the D2 source

// Remove every annotation we added, recovering the clean design. Deterministic
// because we control the exact format: an appended override block introduced by
// FAILURE_MARKER, plus a LABEL_SUFFIX inside each marked node's label.
export function stripAnnotations(d2) {
    const text = String(d2 ?? '');
    const base = text.split(`\n\n${FAILURE_MARKER}`)[0].split(FAILURE_MARKER)[0];
    const clean = base.split(LABEL_SUFFIX).join('');
    return `${clean.trimEnd()}\n`;
}

// Parse the D2 brace nesting into a node model: leaf id -> full dotted path(s),
// plus the flat list of every node path (to compute containers/descendants).
// Our generated D2 is one statement per line: blocks open with `id: "..." {` and
// close with a lone `}`; connections (containing `->`) are single-line, skipped.
export function buildNodeModel(d2) {
    const leafToPaths = new Map();
    const allPaths = [];
    const stack = [];
    for (const raw of String(d2).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.includes('->')) continue;
        if (/\{$/.test(line)) {
            const m = line.match(/^([A-Za-z_][\w-]*)\s*:.*\{$/);
            if (m) {
                stack.push(m[1]);
                const path = stack.join('.');
                allPaths.push(path);
                if (!leafToPaths.has(m[1])) leafToPaths.set(m[1], []);
                leafToPaths.get(m[1]).push(path);
            }
            continue;
        }
        if (line === '}') stack.pop();
    }
    return { leafToPaths, allPaths };
}

const isContainer = (path, allPaths) => allPaths.some((p) => p.startsWith(`${path}.`));
const descendantsOf = (path, allPaths) => allPaths.filter((p) => p.startsWith(`${path}.`));

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Deterministically mark failed nodes red + "✗ NOT DEPLOYED", preserving the rest
// of the diagram verbatim. Containers get a lighter red wash (so nested failed
// nodes stay legible); leaf service nodes get a stronger light-red fill. A failed
// container cascades to every resource nested inside it (it could not exist
// without its container). Returns the annotated D2, or null if nothing mapped.
export function annotateFailedNodes(d2, leaves, model) {
    const { leafToPaths, allPaths } = model;

    const paths = new Set();
    for (const leaf of new Set(leaves)) {
        for (const p of leafToPaths.get(leaf) || []) {
            paths.add(p);
            for (const d of descendantsOf(p, allPaths)) paths.add(d);
        }
    }
    if (paths.size === 0) return null;

    // Map each path back to its leaf so we can suffix the label.
    const markLeaves = new Set([...paths].map((p) => p.split('.').pop()));

    let out = d2;
    for (const leaf of markLeaves) {
        const re = new RegExp(`(\\n[ \\t]*${escapeRe(leaf)}: ")([^"]*)("\\s*\\{)`);
        out = out.replace(re, (match, head, label, tail) =>
            label.includes('NOT DEPLOYED') ? match : `${head}${label}${LABEL_SUFFIX}${tail}`
        );
    }

    const overrides = [...paths]
        .map((p) => {
            const container = isContainer(p, allPaths);
            return [
                // Containers get a lighter red so their failed children stay readable;
                // leaf nodes get a stronger light-red fill.
                `${p}.style.fill: "${container ? '#fdecec' : '#fee2e2'}"`,
                `${p}.style.stroke: "#dc2626"`,
                `${p}.style.stroke-width: 2`,
                `${p}.style.stroke-dash: 4`
            ].join('\n');
        })
        .join('\n');

    return `${out.trimEnd()}\n\n${FAILURE_MARKER}\n${overrides}\n`;
}
