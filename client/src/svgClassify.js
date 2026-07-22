// Shared classification of a rendered D2 <g class="..."> element, used by BOTH the live diagram
// canvas (Diagram.jsx, via CSS classes) and the export pipeline (exportDiagram.js, via real DOM
// removal). Written once, framework-free, so the two never silently disagree on what counts as
// "a label" or "a group box" for a given diagram.
//
// D2 (v0.7.0) tags each shape's outer <g> with class = base64(full node path), e.g.
// "YXdzLmxhbWJkYQ==" → "aws.lambda". Connection groups decode to text containing "(" / "->"
// instead of a clean dotted path.

// Mirror of the sanitization the stateviz prompt applies to a resource id when it becomes a D2
// node id, so a rendered SVG node can be matched back to its resource. Keep in lockstep with the
// prompt's own id-sanitizing rule.
export function sanitizeId(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function decodeNodePath(cls) {
    if (!cls || /\s/.test(cls) || !/^[A-Za-z0-9+/=]+$/.test(cls)) {
        return null;
    }
    let decoded;
    try {
        decoded = atob(cls);
    } catch {
        return null;
    }
    return /^[A-Za-z0-9_.]+$/.test(decoded) ? decoded : null;
}

// A connection's <g> class decodes to something containing "(" or "->" rather than a clean path.
export function isEdgeGroup(cls) {
    if (!cls || /\s/.test(cls) || !/^[A-Za-z0-9+/=]+$/.test(cls)) return false;
    let decoded;
    try {
        decoded = atob(cls);
    } catch {
        return false;
    }
    return decoded.includes('->') || decoded.includes('(');
}

// A semantic group box (COMPUTE / DATA / MESSAGING / ...): its decoded path is a container (not a
// leaf resource id) and isn't one of the two fixed structural boundaries every diagram always has
// (the "aws" Cloud boundary and the "aws.vpc" boundary) — those are architecture, not styling, and
// the user did not ask to hide them.
export function isSemanticGroup(path, byId) {
    if (!path) return false;
    if (path === 'aws' || path === 'aws.vpc') return false;
    const leafId = path.split('.').pop();
    return !byId.has(leafId);
}
