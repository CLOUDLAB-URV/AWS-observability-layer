'use strict';

// Port of the extension's diagramService.js D2 pipeline (lazy-loaded WASM renderer).
let d2RendererPromise = null;

function getD2Renderer() {
    if (!d2RendererPromise) {
        d2RendererPromise = import('@terrastruct/d2').then(({ D2 }) => new D2());
    }
    return d2RendererPromise;
}

// The D2 WASM worker uses a single shared `currentResolve` variable, so concurrent
// compile/render calls race and corrupt each other's results. Serialize all calls
// through this queue so only one compile+render pipeline runs at a time.
let _renderQueue = Promise.resolve();

// Run `task` once the queue drains. Whole OPERATIONS are queued (not individual compile/render
// calls), so a multi-pass pipeline like renderDeployedDiagram never interleaves with another
// request's calls. Anything running inside a queued task must therefore use the unqueued
// primitives (_doRender / compileLaidOut / renderCompiled) — re-entering the queue would deadlock.
function enqueue(task) {
    const next = _renderQueue.then(task, task);
    _renderQueue = next.then(() => {}, () => {});
    return next;
}

export function renderDiagramSvg(diagramText) {
    return enqueue(() => _doRender(diagramText));
}

// Edge labels are emitted by the stateviz prompt as a segmented string
// `"<step> || <action> || <protocol>"` (see server/agents/stateviz/prompt.md, CONNECTIONS).
// `composeLabel` collapses each label to the requested VIEW so we can render variants of the SAME
// diagram: pick action vs protocol content, optionally prefix the workflow step number, or empty
// every edge label (`mode: 'none'`) so ELK reserves no label space and packs services tightly.
// The sentinel ` || ` only ever appears in edge labels; node/container/style/icon strings and any
// legacy single-label diagram.d2 have no sentinel and pass through untouched — full backward compat.
const LABEL_SEP = ' || ';

// Rewrite every EDGE label in a D2 source through `fn(parts, edgeIndex)`, where `parts` are the
// label's ` || `-separated segments and `edgeIndex` counts edge labels in source order. Strings
// without the sentinel (node/container/style/icon labels, and any legacy single-label diagram.d2)
// are left byte-identical, so this is always safe to run over a whole diagram.
export function mapEdgeLabels(diagramText, fn) {
    if (typeof diagramText !== 'string' || !diagramText) return diagramText;
    let edgeIndex = 0;
    return diagramText.replace(/"([^"\n]*)"/g, (full, inner) => {
        if (!inner.includes(LABEL_SEP)) return full; // node/container/style/icon/legacy — untouched
        return `"${fn(inner.split(LABEL_SEP), edgeIndex++) ?? ''}"`;
    });
}

// The text one VIEW shows for a segmented label. A connection label always shows the ACTION segment,
// optionally prefixed with the workflow step number; the trailing protocol segment is still parsed
// (stored diagrams keep emitting it) but is never displayed. `mode: 'none'` yields '' — a `""` label
// that keeps the connection and its `{ style … }` map while reserving no layout space.
function viewText(parts, { mode = 'action', steps = false } = {}) {
    if (mode === 'none') return '';
    // 3 segments = "<step> || <action> || <protocol>"; 2 = "<action> || <protocol>" (pre-steps D2).
    const [step, action] = parts.length >= 3 ? parts : [null, parts[0]];
    let body = action;
    if (steps && step && step.trim()) body = `${step.trim()}. ${body}`;
    return body;
}

// Labels shorter than this read fine on one line and are never worth breaking. Set above the length
// of a protocol label ("4. HTTPS :443") on purpose: a transport and its port are one unit, and
// splitting them across lines looks broken even when it would technically free up some room.
const WRAP_MIN_CHARS = 16;

// The two-line form of a label, or null when it shouldn't/can't be broken. Splits at the space that
// balances the two lines best (minimising the longer one), which keeps the label as narrow as
// possible — the whole point of wrapping, since a narrower label intrudes less on a left-to-right
// diagram. The step number never ends up alone on the first line ("5." reads as a typo).
// D2 renders a `\n` in a label natively, as one <text> with a <tspan> per line.
export function wrapLabel(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (trimmed.length < WRAP_MIN_CHARS) return null;
    const words = trimmed.split(/\s+/);
    if (words.length < 2) return null;
    let best = null;
    for (let i = 1; i < words.length; i++) {
        const head = words.slice(0, i).join(' ');
        const tail = words.slice(i).join(' ');
        if (/^\d+\.$/.test(head)) continue; // don't orphan the step number
        const longest = Math.max(head.length, tail.length);
        if (!best || longest < best.longest) best = { longest, text: `${head}\\n${tail}` };
    }
    return best ? best.text : null;
}

// A harvested `label` holds a REAL newline (D2 resolved the `\n` escape at compile time). Writing
// one straight back into a quoted D2 string would break the source, so re-escape it first.
function toD2Label(text) {
    return String(text ?? '').replace(/\r?\n/g, '\\n');
}

// `wrap: true` renders each label in its two-line form where one exists (labels that shouldn't be
// broken stay on one line, so this is always safe to apply wholesale — it is used to MEASURE the
// wrapped candidate of every label in one compile).
export function composeLabel(diagramText, opts = {}) {
    return mapEdgeLabels(diagramText, (parts) => {
        const text = viewText(parts, opts);
        return (opts.wrap && wrapLabel(text)) || text;
    });
}

// Whether any label in this view has a two-line form at all — if not, the wrapped harvest compile
// would be byte-identical to the single-line one, so it can be skipped.
function viewHasWrappable(diagramText, opts) {
    let found = false;
    mapEdgeLabels(diagramText, (parts) => {
        const text = viewText(parts, opts);
        if (wrapLabel(text)) found = true;
        return text;
    });
    return found;
}

// True when the D2 has at least one segmented (sentinel) edge label — i.e. an emptied "no labels"
// variant would actually differ from the normal render. Legacy single-label diagrams have none.
function diagramHasLabels(diagramText) {
    return typeof diagramText === 'string' && diagramText.includes(LABEL_SEP);
}

// True when the D2 has at least one 3-segment edge label (a workflow step number present).
function diagramHasSteps(diagramText) {
    return typeof diagramText === 'string'
        && /"[^"\n]*\|\|[^"\n]*\|\|[^"\n]*"/.test(diagramText);
}

// The label views the client can switch between, in render order. Connection labels always show the
// ACTION segment; the protocol segment is still carried in the stored D2 (so nothing has to be
// regenerated) but is no longer rendered. `svg` (no step numbers) is the default.
const LABEL_VIEWS = [
    ['svg', { mode: 'action' }],
    ['svgActionSteps', { mode: 'action', steps: true }],
];

// The per-connection label fields D2 fills in at compile time (it measures the text itself) and
// reads back at render time. Plain mutable data on the compiled diagram — the same property that
// the two geometry passes below rely on for `route`.
const LABEL_FIELDS = ['label', 'labelWidth', 'labelHeight', 'labelPosition', 'labelPercentage'];

function harvestLabels(compiled) {
    return (compiled.diagram?.connections || []).map((conn) =>
        Object.fromEntries(LABEL_FIELDS.map((f) => [f, conn[f]])));
}

function applyLabels(diagram, labels) {
    const conns = diagram?.connections || [];
    if (!Array.isArray(labels) || labels.length !== conns.length) return false;
    conns.forEach((conn, i) => { for (const f of LABEL_FIELDS) conn[f] = labels[i][f]; });
    return true;
}

// Where D2 draws a connection's label: the midpoint of its route BY ARC LENGTH (not the middle
// route point — segments differ in length, and an L-bend's corner is not its visual middle).
function routeMidpoint(route) {
    if (!Array.isArray(route) || route.length < 2) return null;
    const segs = [];
    let total = 0;
    for (let i = 1; i < route.length; i++) {
        const len = Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
        segs.push(len);
        total += len;
    }
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
        if (acc + segs[i] >= total / 2) {
            const t = segs[i] ? (total / 2 - acc) / segs[i] : 0;
            return {
                x: route[i].x + (route[i + 1].x - route[i].x) * t,
                y: route[i].y + (route[i + 1].y - route[i].y) * t,
            };
        }
        acc += segs[i];
    }
    return { ...route[route.length - 1] };
}

// Breathing room (px) required around a label before it counts as "fits" — the label is drawn on a
// dark pill, so touching a node border already looks wrong.
const LABEL_FIT_MARGIN = 6;

function labelBoxOf(conn, label) {
    const width = label?.labelWidth || 0;
    const height = label?.labelHeight || 0;
    const mid = width && height ? routeMidpoint(conn.route) : null;
    if (!mid) return null;
    const halfW = width / 2 + LABEL_FIT_MARGIN;
    const halfH = height / 2 + LABEL_FIT_MARGIN;
    return { x0: mid.x - halfW, x1: mid.x + halfW, y0: mid.y - halfH, y1: mid.y + halfH };
}

function boxesOverlap(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Only LEAF shapes count as obstacles: a container (the AWS boundary, a COMPUTE/DATA group) is
// supposed to enclose the labels of the edges routed through it.
function leafShapeBoxes(diagram) {
    const shapes = (diagram?.shapes || []).filter((s) => s?.id && s.pos);
    return shapes
        .filter((s) => !shapes.some((o) => o !== s && o.id.startsWith(`${s.id}.`)))
        .map((s) => ({ x0: s.pos.x, x1: s.pos.x + s.width, y0: s.pos.y, y1: s.pos.y + s.height }));
}

// Does an axis-aligned route segment pass through a box?
function segmentHitsBox(a, b, box) {
    const seg = {
        x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
        y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y),
    };
    return boxesOverlap(seg, box);
}

// How badly a label placed at `box` (belonging to connection `index`) collides here.
//   severe — it sits on a service icon or on another label: unreadable, must be fixed by giving the
//            layout more room.
//   mild   — another connection's LINE crosses it. Only lines drawn AFTER this label count: D2 emits
//            connections in order, so an earlier line ends up hidden behind this label's opaque dark
//            pill, while a later one is painted over the text. The label's own route is excluded —
//            D2 already masks a gap in it.
function labelCollisions(diagram, index, box, boxes, nodes) {
    let severe = 0;
    let mild = 0;
    if (!box) return { severe, mild };
    for (const node of nodes) if (boxesOverlap(box, node)) severe++;
    boxes.forEach((other, j) => {
        if (j !== index && other && boxesOverlap(box, other)) severe++;
    });
    const conns = diagram?.connections || [];
    for (let j = index + 1; j < conns.length; j++) {
        const route = conns[j].route;
        if (!Array.isArray(route)) continue;
        for (let k = 1; k < route.length; k++) {
            if (segmentHitsBox(route[k - 1], route[k], box)) { mild++; break; }
        }
    }
    return { severe, mild };
}

// A severe collision outweighs any number of mild ones.
const SEVERE_WEIGHT = 1000;

// Above this single-line width (px) a label is long enough that two lines simply read better — more
// compact, less of a banner stretched across the diagram. Below it, one line is cleaner. This is the
// tie-break used when both forms are equally free of collisions.
const WRAP_PREFER_WIDTH = 150;

// Per connection, pick the label form that interferes least: the single-line text or its two-line
// version. Wrapping trades width for height, which helps on a cramped horizontal run but HURTS where
// a taller label reaches a neighbouring line — so it genuinely differs per label, and a blanket
// wrap measurably makes things worse. Ties go to the single line, which reads better.
// Returns the chosen label metrics per connection plus the set of connections still severely stuck.
function chooseLabelForms(diagram, singleLabels, wrappedLabels) {
    const conns = diagram?.connections || [];
    const nodes = leafShapeBoxes(diagram);
    // Score against the single-line placement of every OTHER label: a stable reference, so the
    // choice doesn't depend on the order connections happen to be visited in.
    const refBoxes = conns.map((conn, i) => labelBoxOf(conn, singleLabels[i]));
    const chosen = [];
    const stuck = new Set();
    const evaluate = (conn, i, label) => {
        const { severe, mild } = labelCollisions(diagram, i, labelBoxOf(conn, label), refBoxes, nodes);
        return { label, severe, score: severe * SEVERE_WEIGHT + mild };
    };
    conns.forEach((conn, i) => {
        const single = evaluate(conn, i, singleLabels[i]);
        const wrappedLabel = wrappedLabels?.[i];
        const wrapped = wrappedLabel && wrappedLabel.label !== singleLabels[i].label
            ? evaluate(conn, i, wrappedLabel)
            : null;
        let best;
        if (!wrapped) best = single;
        else if (wrapped.score !== single.score) best = wrapped.score < single.score ? wrapped : single;
        // Equally clean either way: break long labels, keep short ones on one line.
        else best = (singleLabels[i].labelWidth || 0) > WRAP_PREFER_WIDTH ? wrapped : single;
        chosen.push(best.label);
        if (best.severe > 0) stuck.add(i);
    });
    return { chosen, stuck };
}

// Per edge, the widest CHOSEN label across all views (normally the step-numbered one). One geometry
// serves every view, so space must be reserved for the widest form any view will actually show —
// otherwise switching Action→Protocol could overflow a gap sized only for the shorter one. Also
// unions the per-view "still severely stuck" sets: an edge cramped in any view needs the room.
function widestLabels(chosenPerView, picks) {
    const count = chosenPerView[0]?.length || 0;
    const widest = [];
    for (let i = 0; i < count; i++) {
        let best = null;
        for (const chosen of chosenPerView) {
            const label = chosen[i];
            if (label && (!best || (label.labelWidth || 0) > (best.labelWidth || 0))) best = label;
        }
        widest.push(best);
    }
    const misfits = new Set();
    for (const pick of picks || []) for (const i of pick.stuck) misfits.add(i);
    return { widest, misfits };
}

// Render the label-view matrix of a deployed-state diagram from a single stored D2, so the client
// can switch views instantly with no re-render/LLM.
//
// Labels are drawn on a layout that was computed WITHOUT them. ELK reserves a whole dummy layer per
// labelled edge, which on a real 11-edge diagram inflated the width from 1897px to 2800px (+48%) —
// space the labels don't need. Shrinking the font (-7%) or wrapping the text (0%) barely dents that,
// because the cost is structural, not textual. So the pipeline lays out label-free and injects the
// measured labels afterwards, giving every view the tight geometry. Only the few labels that would
// then collide get space reserved for them, in one adaptive second pass, so labels are always shown
// complete and at full size. Every view shares one geometry, so switching view never moves anything.
export async function renderDeployedDiagram(diagramText) {
    const hasSteps = diagramHasSteps(diagramText);
    // Legacy diagrams (no ` || ` sentinel) have nothing to compose: one render serves every view.
    if (!diagramHasLabels(diagramText)) {
        const only = await renderDiagramSvg(diagramText);
        return {
            svg: only.svg,
            svgActionSteps: only.svg,
            hasSteps: false,
            error: only.error,
        };
    }
    return enqueue(() => _renderLabelViews(diagramText, hasSteps));
}

async function _renderLabelViews(diagramText, hasSteps) {
    // Without step numbers the numbered view is identical to the plain one — don't render it.
    const views = hasSteps ? LABEL_VIEWS : LABEL_VIEWS.slice(0, 1);
    try {
        // 1. Let D2 measure BOTH candidate forms of every label — one line and two lines (compile
        //    fills in labelWidth/labelHeight). The layouts these compiles produce are thrown away;
        //    only the measurements are kept, so a per-label choice can mix the two with exact sizes.
        const singleHarvests = [];
        const wrappedHarvests = [];
        for (const [, opts] of views) {
            singleHarvests.push(harvestLabels(await compileLaidOut(composeLabel(diagramText, opts))));
            wrappedHarvests.push(viewHasWrappable(diagramText, opts)
                ? harvestLabels(await compileLaidOut(composeLabel(diagramText, { ...opts, wrap: true })))
                : null);
        }

        // 2. The tight, label-free layout every view will share.
        let layout = await compileLaidOut(composeLabel(diagramText, { mode: 'none' }));
        const connCount = (layout.diagram?.connections || []).length;
        if (singleHarvests.some((h) => h.length !== connCount)) {
            throw new Error('label/connection count mismatch — falling back to laid-out labels');
        }

        // 3. Pick each label's form on this geometry, then — only for the ones still sitting on an
        //    icon or another label — re-lay-out reserving space for exactly those, using the chosen
        //    text (newline included) so D2 measures the reservation. One extra pass at most. Mild
        //    line crossings never widen the diagram; they're already minimised by the form choice.
        let picks = views.map((_, v) => chooseLabelForms(layout.diagram, singleHarvests[v], wrappedHarvests[v]));
        const stuck = widestLabels(picks.map((p) => p.chosen), picks);
        if (stuck.misfits.size) {
            layout = await compileLaidOut(mapEdgeLabels(diagramText, (parts, i) =>
                (stuck.misfits.has(i) ? toD2Label(stuck.widest[i]?.label) : '')));
            // Geometry moved — re-pick on the layout that actually ships.
            picks = views.map((_, v) => chooseLabelForms(layout.diagram, singleHarvests[v], wrappedHarvests[v]));
        }

        // 4. Render each view onto that one geometry. Clone per view so the injected labels of one
        //    view can't leak into the next.
        const out = { hasSteps, error: null };
        for (let i = 0; i < views.length; i++) {
            const diagram = structuredClone(layout.diagram);
            if (!applyLabels(diagram, picks[i].chosen)) throw new Error('label injection failed');
            out[views[i][0]] = await renderCompiled({ diagram, renderOptions: layout.renderOptions });
        }
        if (!hasSteps) out.svgActionSteps = out.svg;
        return out;
    } catch (error) {
        // Any failure in the injection pipeline falls back to plain per-view renders (the wider,
        // label-sized layout) — a roomier diagram is far better than a broken one.
        return _renderLabelViewsPlain(diagramText, hasSteps, error);
    }
}

// Fallback: render each view the straightforward way, letting ELK lay the labels out. Runs INSIDE
// the queued task, so it uses the unqueued primitive directly (renderDiagramSvg would deadlock).
async function _renderLabelViewsPlain(diagramText, hasSteps, cause) {
    const action = await _doRender(composeLabel(diagramText, { mode: 'action' }));
    const actionSteps = hasSteps
        ? await _doRender(composeLabel(diagramText, { mode: 'action', steps: true }))
        : action;
    return {
        svg: action.svg,
        svgActionSteps: actionSteps.svg,
        hasSteps,
        error: action.error || (cause ? String(cause.message || cause) : null),
    };
}

// Compile + lay out a D2 source, then apply the two geometry fix-up passes. Unqueued: callers are
// either the queued _doRender or an already-queued multi-pass pipeline.
async function compileLaidOut(text) {
    const d2 = await getD2Renderer();
    // ELK layout engine: orthogonal edge routing and tighter, more compact placement than
    // dagre — much cleaner for the left-to-right AWS architecture diagrams this app produces.
    // (ELK does NOT center connection endpoints on its own — see centerConnectionEndpoints.)
    const compiled = await d2.compile(text, { layout: 'elk' });
    centerConnectionEndpoints(compiled.diagram);
    orthogonalizeConnectionRoutes(compiled.diagram);
    return compiled;
}

// Render an already-compiled+laid-out diagram to an embeddable SVG string. Unqueued (see above).
async function renderCompiled({ diagram, renderOptions }) {
    const d2 = await getD2Renderer();
    // themeID 200 = "Dark Mumford": dark defaults so labels and edges are light on the
    // app's dark canvas. Node/container fills are still set explicitly by the prompts.
    const rawSvg = await d2.render(diagram, { ...renderOptions, themeID: 200 });
    return prepareSvgForEmbed(typeof rawSvg === 'string' ? rawSvg : String(rawSvg));
}

async function _doRender(diagramText) {
    const text = (diagramText ?? '').trim();
    if (!text) {
        return { svg: '', error: null };
    }

    try {
        return { svg: await renderCompiled(await compileLaidOut(text)), error: null };
    } catch (error) {
        return { svg: '', error: error instanceof Error ? error.message : String(error) };
    }
}

// Float-compare tolerance for "this point sits on that edge of the box" / "this segment is
// axis-aligned". Shared by both geometry passes below.
const ROUTE_EPS = 0.5;

// Index the diagram's shapes by id (skipping any without a position); shared by both passes.
function shapeIndexById(diagram) {
    const shapeById = new Map();
    for (const shape of diagram?.shapes || []) {
        if (shape?.id && shape.pos) shapeById.set(shape.id, shape);
    }
    return shapeById;
}

// Which side of `shape` the point sits on. `point` is always a real connection endpoint for THIS
// shape (route[0]/route[last] of a connection whose src/dst IS this shape's id), so which side it's
// on is determined purely by which edge its x (or y) coordinate matches — deliberately NOT
// requiring the other coordinate to fall within the box's range: ELK's free port placement can land
// an endpoint's secondary coordinate well outside the node's own extent entirely (confirmed
// empirically — a Lambda->S3 edge's endpoint landed at y=217 against an S3 box spanning y=[68,196]),
// and a range requirement silently skipped exactly the badly-placed points these fixes exist for.
function sideOf(point, shape) {
    if (!point) return null;
    const left = shape.pos.x, right = shape.pos.x + shape.width;
    const top = shape.pos.y, bottom = shape.pos.y + shape.height;
    if (Math.abs(point.x - left) <= ROUTE_EPS) return 'left';
    if (Math.abs(point.x - right) <= ROUTE_EPS) return 'right';
    if (Math.abs(point.y - top) <= ROUTE_EPS) return 'top';
    if (Math.abs(point.y - bottom) <= ROUTE_EPS) return 'bottom';
    return null;
}

// ELK leaves ordinary shape nodes with no port constraint at all (it only fixes ports for
// SQL-table columns), so it's free to attach a connection's endpoint wherever minimizes bends/
// crossings — in practice that drifts off a node's true center, and when several connections land
// on the same side of one node they cluster instead of spacing evenly. There is no D2-language or
// JS-API knob for this (confirmed against the installed @terrastruct/d2's CompileOptions and D2's
// own `vars: d2-config` surface — neither exposes ELK port/spacing passthrough), so this reaches
// into the compiled geometry directly, between compile() and render(): `shapes[].pos/width/height`
// and `connections[].route` are plain mutable data at this point, confirmed to actually change the
// rendered SVG when edited here.
//
// For each shape, every connection touching one of its four sides gets its endpoint moved to an
// evenly-spaced fraction of that side (a lone connection lands at exactly the center — frac 1/2 —
// so the same formula fixes both "off-center" and "clustered" without a special case), preserving
// the connections' original relative order along that side so this only changes spacing, never
// which line ends up on top (ELK's own crossing-minimization stays intact).
function centerConnectionEndpoints(diagram) {
    const shapeById = shapeIndexById(diagram);
    if (!shapeById.size) return;

    // Group every connection-endpoint touching a shape by (shape, side) so each group can be
    // evenly redistributed together.
    const groups = new Map(); // `${shapeId} ${side}` -> [{ point, adjacent, axis, orderVal }]
    for (const conn of diagram.connections || []) {
        const route = conn.route;
        if (!route || route.length < 2) continue;
        const firstPt = route[0], lastPt = route[route.length - 1];
        const ends = [
            [conn.src, firstPt, route[1], lastPt],
            [conn.dst, lastPt, route[route.length - 2], firstPt],
        ];
        for (const [shapeId, point, adjacent, otherEnd] of ends) {
            const shape = shapeById.get(shapeId);
            if (!shape) continue;
            const side = sideOf(point, shape);
            if (!side) continue;
            const axis = side === 'left' || side === 'right' ? 'y' : 'x';
            const key = `${shapeId} ${side}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ point, adjacent, otherEnd, axis, orderVal: point[axis], shape });
        }
    }

    for (const attachments of groups.values()) {
        const n = attachments.length;
        const { shape, axis } = attachments[0];
        const extent = axis === 'y' ? shape.height : shape.width;
        const origin = axis === 'y' ? shape.pos.y : shape.pos.x;
        attachments
            .sort((a, b) => a.orderVal - b.orderVal) // keep ELK's own left-to-right/top-to-bottom order
            .forEach(({ point, adjacent, otherEnd, axis }, i) => {
                const target = origin + extent * ((i + 1) / (n + 1));
                // Only carry the adjacent bend point along if it's genuinely this end's own
                // straight approach stub (already aligned with the endpoint on this axis) AND
                // it isn't actually the connection's OTHER endpoint — on a short (2-point) route
                // the "adjacent" point IS that other endpoint (src/dst share both route points,
                // just swapped), and that point has its own independent target elsewhere in this
                // same pass; carrying it along here would let whichever end runs second silently
                // clobber the other's fix (confirmed empirically on a real multi-container diagram).
                if (adjacent !== otherEnd && Math.abs(adjacent[axis] - point[axis]) <= ROUTE_EPS) {
                    adjacent[axis] = target;
                }
                point[axis] = target;
            });
    }
}

// The stub axis a node side forces on the segment touching it: a left/right attachment must
// leave/enter horizontally, a top/bottom one vertically. Unknown side -> null (treated as
// horizontal downstream, the dominant direction:right case).
function stubAxisOf(side) {
    if (side === 'left' || side === 'right') return 'h';
    if (side === 'top' || side === 'bottom') return 'v';
    return null;
}

// A new route point cloned from an existing one (preserving any extra fields D2's geo.Point may
// carry) with x/y overridden.
function routePoint(sample, x, y) {
    return { ...sample, x, y };
}

// centerConnectionEndpoints moves endpoints to their centered/distributed slots, which is exactly
// what turns some of ELK's straight 2-point lines into diagonals: ELK draws a direct horizontal
// line only between two nodes it placed at the same y, and once the two ends get redistributed to
// different slots (e.g. a lone edge -> its node's center, but the far end -> one of two thirds on a
// shared side) that line tilts. ELK itself never emits diagonals, and moving an endpoint on a
// MULTI-point route carries its perpendicular stub along so those stay orthogonal — so the only
// diagonals are these 2-point straight-turned-tilted edges. Rebuild each as a clean orthogonal
// (Manhattan) path so the diagram shows only horizontal/vertical segments (the user dislikes
// diagonals; an H-V-H / L jog is the agreed fallback when the two ends can't share a height).
function orthogonalizeConnectionRoutes(diagram) {
    const shapeById = shapeIndexById(diagram);
    if (!shapeById.size) return;

    for (const conn of diagram.connections || []) {
        const route = conn.route;
        if (!route || route.length < 2) continue;

        const hasDiagonal = route.some((p, i) =>
            i > 0 && Math.abs(p.x - route[i - 1].x) > ROUTE_EPS
                  && Math.abs(p.y - route[i - 1].y) > ROUTE_EPS);
        if (!hasDiagonal) continue;

        // Only the 2-point straight-turned-diagonal case is expected and safe to rebuild. A longer
        // route with a diagonal isn't something the centering pass produces (it preserves ELK's
        // orthogonal bends), so leaving any such route untouched is safer than risking a rebuilt
        // line cutting straight through a container ELK had routed it around.
        if (route.length !== 2) continue;

        const a = route[0], b = route[1];
        const srcShape = shapeById.get(conn.src);
        const dstShape = shapeById.get(conn.dst);
        const aAxis = stubAxisOf(srcShape ? sideOf(a, srcShape) : null) || 'h';
        const bAxis = stubAxisOf(dstShape ? sideOf(b, dstShape) : null) || 'h';

        if (aAxis === 'h' && bAxis === 'h') {
            // H-V-H: leave/enter both nodes horizontally, one vertical step in the gap between them.
            const mx = (a.x + b.x) / 2;
            conn.route = [a, routePoint(a, mx, a.y), routePoint(b, mx, b.y), b];
        } else if (aAxis === 'v' && bAxis === 'v') {
            // V-H-V: leave/enter both vertically, one horizontal step between them.
            const my = (a.y + b.y) / 2;
            conn.route = [a, routePoint(a, a.x, my), routePoint(b, b.x, my), b];
        } else if (aAxis === 'h') {
            // Source horizontal, dest vertical: single L-bend (H then V).
            conn.route = [a, routePoint(a, b.x, a.y), b];
        } else {
            // Source vertical, dest horizontal: single L-bend (V then H).
            conn.route = [a, routePoint(a, a.x, b.y), b];
        }
    }
}

// Strip the XML declaration (invalid inside HTML) and inject explicit width/height
// from the viewBox so the SVG has an intrinsic size for CSS layout. Also drop D2's
// full-canvas background rect (the theme's neutral `fill-N7` fill) so the diagram is
// transparent and the app's dark gridded canvas shows through behind it.
function prepareSvgForEmbed(svg) {
    let s = svg.replace(/^<\?xml[^?]*\?>\s*/i, '');
    s = s.replace(
        /<svg([^>]*\s)viewBox="0 0 ([0-9.]+) ([0-9.]+)"/,
        (m, before, w, h) =>
            before.includes('width=') ? m
            : `<svg${before}viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"`
    );
    // Remove the first full-canvas background rect (class "… fill-N7"). D2 emits exactly one,
    // right after the opening defs, as the diagram's solid background.
    s = s.replace(/<rect\b[^>]*\bclass="[^"]*\bfill-N7\b[^"]*"[^>]*\/>/, '');
    return s;
}

// LLMs sometimes wrap D2 in fences despite instructions — strip them defensively.
export function stripCodeFences(text) {
    return text
        .trim()
        .replace(/^```(?:d2)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}
