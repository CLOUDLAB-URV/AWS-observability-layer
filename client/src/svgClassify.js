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

// Shared by every classifier below: a D2 <g class="..."> is always base64, so this is the one
// place that attempts the decode — decodeNodePath/isEdgeGroup/edgeTouchesPath all build on it
// instead of each repeating the same try/catch + charset guard.
function tryDecode(cls) {
    if (!cls || /\s/.test(cls) || !/^[A-Za-z0-9+/=]+$/.test(cls)) return null;
    try {
        return atob(cls);
    } catch {
        return null;
    }
}

export function decodeNodePath(cls) {
    const decoded = tryDecode(cls);
    return decoded && /^[A-Za-z0-9_.]+$/.test(decoded) ? decoded : null;
}

// A connection's <g> class decodes to something containing "(" or "->" rather than a clean path.
export function isEdgeGroup(cls) {
    const decoded = tryDecode(cls);
    return !!decoded && (decoded.includes('->') || decoded.includes('('));
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

// Whether a node path is a CONTAINER (a box something is drawn inside) rather than a leaf shape.
// D2 gives a container and a leaf the exact same markup, so the only available signal is the path
// set: a container is a path some other path is nested under. Same structural rule the server uses
// on the compiled diagram (`leafShapeBoxes` in diagram.js). Used to tell a clickable VPC/subnet box
// apart from a clickable service icon — both are backed by a resource, but a box is styled and
// hit-tested differently because it is huge and holds the others.
export function isContainerPath(path, allPaths) {
    if (!path) return false;
    const prefix = `${path}.`;
    for (const other of allPaths) {
        if (other !== path && other.startsWith(prefix)) return true;
    }
    return false;
}

// The external actor (Internet / end-user / browser…), per the stateviz prompt: drawn as a plain
// top-level node, sibling of "aws", never nested under it. It's sometimes backed by a real
// `resources` entry and sometimes purely decorative (the prompt allows drawing it whenever "the
// deployment is publicly reachable" with no backing resource) — so unlike a normal service node it
// can't be identified via a `byId` match. It CAN be identified structurally: every real resource
// and every semantic group always lives under the fixed "aws" container (full dotted paths like
// "aws.foo"/"aws.vpc.bar"), so a decoded path with no "." that isn't "aws" itself is unambiguously
// this external node, independent of whether a resource happens to back it.
export function isExternalNode(path) {
    return !!path && path !== 'aws' && !path.includes('.');
}

// Whether an edge's <g> class touches the given node path (i.e. that node is one of its two
// endpoints). D2 edge class decodes to raw text like "(client -> aws.app_alb)[0]", not a clean
// path, so this re-decodes without decodeNodePath's dotted-path validation and matches `path` as a
// whole id/dotted-path token rather than a substring (so "client" doesn't match "client_2").
export function edgeTouchesPath(cls, path) {
    if (!path) return false;
    const decoded = tryDecode(cls);
    if (!decoded) return false;
    const tokens = decoded.match(/[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g) || [];
    return tokens.includes(path);
}
