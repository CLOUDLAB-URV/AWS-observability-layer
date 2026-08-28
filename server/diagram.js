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

// Edge labels are emitted by the stateviz prompt as a segmented string `"<step> || <action>"`
// (see server/agents/stateviz/prompt.md, CONNECTIONS). `composeLabel` collapses each label to the
// requested VIEW so we can render variants of the SAME diagram — with or without the step number
// prefix. The sentinel ` || ` only ever appears in edge labels; node/container/style/icon strings
// and any legacy single-label diagram.d2 have no sentinel and pass through untouched.
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

// A segmented label's parts. The current form is `"<step> || <action>"`; older stored diagrams carry
// a trailing protocol segment that is no longer displayed (`"<step> || <action> || <protocol>"`),
// and the oldest carry no step at all (`"<action> || <protocol>"`). A step is always DIGITS AND DOTS
// only (`3`, or the sub-step `3.1` that renumberSteps assigns), which tells those two 2-segment forms
// apart with no ambiguity — so every stored diagram, of any vintage, keeps rendering the right text.
// The third label segment the stateviz prompt adds to a connection it deliberately declared
// BACKWARDS so the layout would not drag a subnet out of its column (see prompt.md, BACKWARD EDGES).
// It never reaches the canvas — splitLabel only ever renders the first two segments — it exists so
// the app can restore the true direction for numbering and flip the drawn arrowhead.
const BACK_MARKER = 'back';

// The other marker that can occupy that same third slot: this connection exists to bring something
// BACK to whoever opened it — an image pulled, secrets fetched, rows queried — so it is drawn with a
// head at both ends. Like `back` it never reaches the canvas, and the two are mutually exclusive: an
// edge carrying both is treated as `back`, since a one-way egress is not an exchange.
const BOTH_MARKER = 'both';

export function isBackEdgeLabel(parts) {
    return Array.isArray(parts) && parts.length >= 3 && parts[2].trim() === BACK_MARKER;
}

export function isBothEndsLabel(parts) {
    return Array.isArray(parts) && parts.length >= 3
        && parts[2].trim() === BOTH_MARKER && !isBackEdgeLabel(parts);
}

function splitLabel(parts) {
    return parts.length >= 2 && /^\d+(?:\.\d+)*$/.test(parts[0].trim())
        ? { step: parts[0].trim(), action: parts[1] }
        : { step: null, action: parts[0] };
}

// The text one VIEW shows for a segmented label: the action, optionally prefixed with its workflow
// step number. A root step keeps the trailing dot it has always had ("3. Query orders"); a sub-step
// already reads as a number on its own, so a second dot would only clutter it ("3.1 Query orders").
function viewText(parts, { steps = false } = {}) {
    const { step, action } = splitLabel(parts);
    if (!steps || !step) return action;
    return step.includes('.') ? `${step} ${action}` : `${step}. ${action}`;
}

// Empty every edge label, so ELK reserves no label space and packs the services tightly. A `""`
// label keeps the connection and its `{ style … }` map — only the text (and its layout cost) goes.
function stripLabels(diagramText) {
    return mapEdgeLabels(diagramText, () => '');
}

// A connection line in a generated diagram: declared at the top level, one per line, with the full
// path on both ends — `aws.networking.apigw -> aws.compute.orders_fn: "3 || POST /api/orders" { … }`
// (the stateviz prompt mandates exactly this shape). Anything else — `<->`, `--`, a chained
// `a -> b -> c`, two connections on one line — simply fails to match, which trips the count check in
// renumberSteps and leaves the diagram's own numbers alone.
const EDGE_LINE = /^\s*([\w.]+)\s*->\s*([\w.]+)\s*:\s*"([^"\n]*)"/;

// The edges of a diagram, in source order, keeping ONLY the ones whose label carries the sentinel —
// the same subset, in the same order, that `mapEdgeLabels` hands an `edgeIndex` to. That shared index
// is how renumbered steps are written back.
function parseEdges(diagramText) {
    const edges = [];
    for (const line of diagramText.split('\n')) {
        const match = EDGE_LINE.exec(line);
        if (!match || !match[3].includes(LABEL_SEP)) continue;
        const parts = match[3].split(LABEL_SEP);
        const { step } = splitLabel(parts);
        // A `back` edge is written the wrong way round on purpose; the flow numbering has to see the
        // direction the traffic ACTUALLY takes, or the steps come out in the wrong order.
        const [src, dst] = isBackEdgeLabel(parts) ? [match[2], match[1]] : [match[1], match[2]];
        edges.push({ src, dst, step: step === null ? null : Number(step) });
    }
    return edges;
}

// Re-derive every step number from the SHAPE of the flow, so the numbers tell the diagram's story
// instead of a flat 1..N that pretends everything is sequential.
//
// A flat count breaks down the moment the architecture splits: an API Gateway fanning out to three
// lambdas gives 3/4/5, and what those lambdas then do becomes 6..11 — so "7. Publish order event"
// reads as if it followed 6, when it actually follows 3. The fix is a sub-level: what happens INSIDE
// branch 3 is 3.1, 3.2.
//
// Sub-numbering is reserved for the case it was asked for — the diagram genuinely SPLITTING
// FUNCTIONALITY (several endpoints, a lambda each, every one with its own flow behind it). The
// objective stand-in for that is "at least two of the branches carry on with more edges": a router
// feeding three lambdas that each go on to do things qualifies; one lambda writing to a table and
// publishing an event does not — that's two outputs of the SAME functionality, and it stays flat.
// Only the root level ever descends, so a label never grows past one dot.
//
// The LLM's own numbers are not the output — they are the TRAVERSAL ORDER (which branch comes
// first), the one thing the model knows and the topology cannot say. Anything unexpected (an edge
// with no number, a line this can't parse, a label/edge count that disagrees) returns the diagram
// untouched, so the worst case is exactly today's numbering.
// Fold the mirrored copies of one logical edge into a single entry. `groupOf[i]` maps each original
// edge onto its group. Used both to number the flow and to keep the label-space reservation
// symmetric across zones — reserving room on one branch but not its mirror pulls the two out of the
// column they are supposed to share.
function collapseMirroredEdges(rawEdges) {
    const hasReplicas = rawEdges.some((e) => e.src.includes('__') || e.dst.includes('__'));
    const nodeKey = (path) => {
        if (!hasReplicas) return path;
        const leaf = path.split('.').pop();
        const cut = leaf.indexOf('__');
        return cut === -1 ? leaf : leaf.slice(0, cut);
    };
    const edges = [];
    const groupOf = new Array(rawEdges.length);
    const seen = new Map();
    rawEdges.forEach((edge, i) => {
        const src = nodeKey(edge.src);
        const dst = nodeKey(edge.dst);
        const key = `${src}\u0000${dst}`;
        if (!seen.has(key)) {
            seen.set(key, edges.length);
            edges.push({ src, dst, step: edge.step });
        } else {
            // Mirrored copies of one step: keep the earliest number the model gave, since that is
            // what decides which branch the traversal walks first.
            const at = seen.get(key);
            edges[at].step = Math.min(edges[at].step, edge.step);
        }
        groupOf[i] = seen.get(key);
    });
    return { edges, groupOf };
}

export function renumberSteps(diagramText) {
    if (typeof diagramText !== 'string' || !diagramText.includes(LABEL_SEP)) return diagramText;
    const rawEdges = parseEdges(diagramText);
    if (!rawEdges.length || rawEdges.some((e) => !Number.isFinite(e.step))) return diagramText;
    let labelCount = 0;
    mapEdgeLabels(diagramText, (parts) => { labelCount++; return parts.join(LABEL_SEP); });
    if (labelCount !== rawEdges.length) return diagramText;

    // MULTI-AZ: the same resource is drawn once per subnet, as `<id>__<subnet id>` (see the stateviz
    // prompt's NODE IDS). Those copies are ONE thing, so the arrows mirrored across zones are one
    // logical step, not several: Internet fanning out to both ALB copies is a single "load balance",
    // each ALB reaching the Auto Scaling copy in its own AZ is a single "forward", and both of those
    // egressing through the one NAT Gateway is a single "egress". The rule that captures all three
    // is the same: two edges are the SAME STEP when their source and destination BASE ids match.
    //
    // So the flow is numbered over a COLLAPSED graph — copies folded back into the resource they
    // belong to, duplicate edges merged — and every original edge then takes its group's number.
    // Without a `__` anywhere this is skipped entirely, so diagrams with no replicas keep running
    // through the exact same code path they always did.
    const { edges, groupOf } = collapseMirroredEdges(rawEdges);

    // Outgoing edges per node, walked in the order the model numbered them.
    const outgoing = new Map();
    edges.forEach((edge, i) => {
        if (!outgoing.has(edge.src)) outgoing.set(edge.src, []);
        outgoing.get(edge.src).push(i);
    });
    for (const list of outgoing.values()) list.sort((a, b) => edges[a].step - edges[b].step);

    const numbers = new Array(edges.length).fill(null);
    const taken = new Array(edges.length).fill(false);
    const pending = (node) => (outgoing.get(node) || []).filter((i) => !taken[i]);

    // Number the flow leaving `node` at `prefix` level, starting at `counter`; returns the next free
    // counter at that level. Each edge is numbered on first visit only, so cycles terminate.
    const walk = (node, prefix, counter) => {
        let next = counter;
        const siblings = pending(node);
        if (!siblings.length) return next;
        // Edges leaving one node are SIBLINGS: consecutive numbers at the current level, never
        // children of each other.
        for (const i of siblings) {
            taken[i] = true;
            numbers[i] = prefix ? `${prefix}.${next}` : String(next);
            next++;
        }
        const carryOn = siblings.filter((i) => pending(edges[i].dst).length);
        if (!prefix && siblings.length > 1 && carryOn.length > 1) {
            // A real split: each branch continues inside its own number.
            for (const i of siblings) walk(edges[i].dst, numbers[i], 1);
            return next;
        }
        for (const i of siblings) next = walk(edges[i].dst, prefix, next);
        return next;
    };

    // Start where the model says the flow starts, then pick up anything left over (a disconnected
    // piece, or an edge only reachable through a cycle) as a fresh top-level run.
    const entry = edges.reduce((a, b) => (b.step < a.step ? b : a));
    let counter = walk(entry.src, '', 1);
    edges.forEach((edge, i) => { if (!taken[i]) counter = walk(edge.src, '', counter); });
    if (numbers.some((n) => n === null)) return diagramText;

    return mapEdgeLabels(diagramText, (parts, i) => [numbers[groupOf[i]], ...parts.slice(1)].join(LABEL_SEP));
}

// Labels shorter than this read fine on one line and are never worth breaking: two stubby lines look
// worse than the sliver of width they save, and a label this short barely intrudes to begin with.
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
        if (/^\d+(?:\.\d+)*\.?$/.test(head)) continue; // don't orphan the step number ("5." / "5.1")
        const longest = Math.max(head.length, tail.length);
        if (!best || longest < best.longest) best = { longest, text: `${head}\\n${tail}` };
    }
    return best ? best.text : null;
}

// The separator the stateviz prompt joins a network box label with: `"VPC · 10.0.0.0/16"`,
// `"SUBNET · 10.0.1.0/24 · us-east-1a"`. It plays the same role for BOX labels that ` || ` plays for
// edge labels — it is the one signal that says "this quoted string is a VPC/subnet title". Nothing
// else in a generated diagram carries it: service labels are one word ("Lambda"), group labels too
// ("COMPUTE"), the cloud boundary has none ("AWS Cloud (us-east-1)"), and icon paths and colours are
// plain strings.
const BOX_SEP = ' · ';

// A box label only earns a second line past this. Higher than WRAP_MIN_CHARS because a container is
// wide by nature — breaking a short title would just make the box taller for nothing.
const BOX_WRAP_MIN_CHARS = 24;

// Break the VPC / subnet box titles over two lines so a long one stops setting its box's minimum
// width and stretching the whole diagram sideways. Splits at the ` · ` that MINIMISES THE LONGER
// LINE — the same criterion wrapLabel uses on spaces, and for the same reason: on a left-to-right
// diagram the narrowest label intrudes least. The separator itself is dropped at the break, since
// the line break already separates.
//
// Everything else passes through byte for byte: strings without the separator, strings carrying the
// edge sentinel (belt and braces — an action segment could in principle contain a "·"), labels
// already broken (so this is idempotent), and anything with no split point that helps.
export function wrapBoxLabels(diagramText) {
    if (typeof diagramText !== 'string' || !diagramText.includes(BOX_SEP)) return diagramText;
    return diagramText.replace(/"([^"\n]*)"/g, (full, inner) => {
        if (!inner.includes(BOX_SEP) || inner.includes(LABEL_SEP)) return full;
        if (inner.includes('\\n') || inner.length < BOX_WRAP_MIN_CHARS) return full;
        const parts = inner.split(BOX_SEP);
        if (parts.length < 2) return full;
        let best = null;
        for (let i = 1; i < parts.length; i++) {
            const head = parts.slice(0, i).join(BOX_SEP);
            const tail = parts.slice(i).join(BOX_SEP);
            const longest = Math.max(head.length, tail.length);
            if (!best || longest < best.longest) best = { longest, text: `${head}\\n${tail}` };
        }
        // A split always narrows the longest line (head + tail + 3 === inner.length), so any
        // candidate found is an improvement.
        return best ? `"${best.text}"` : full;
    });
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

// True when at least one edge label carries a workflow step number.
function diagramHasSteps(diagramText) {
    let found = false;
    mapEdgeLabels(diagramText, (parts) => {
        if (splitLabel(parts).step) found = true;
        return '';
    });
    return found;
}

// The label views the client can switch between, in render order. Both show the action; they differ
// only in whether the step number is prefixed. `svg` (no step numbers) is the default.
const LABEL_VIEWS = [
    ['svg', { steps: false }],
    ['svgActionSteps', { steps: true }],
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
// The point `frac` of the way along a route, measured by length. `frac` 0.5 is the midpoint, which
// is where D2 always draws a connection's label — it offers no way to move it along the wire, so
// sliding a label is done by translating it in the finished SVG (see applyLabelSlides).
function routePointAt(route, frac) {
    if (!Array.isArray(route) || route.length < 2) return null;
    const segs = [];
    let total = 0;
    for (let i = 1; i < route.length; i++) {
        const len = Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
        segs.push(len);
        total += len;
    }
    const want = total * frac;
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
        if (acc + segs[i] >= want) {
            const t = segs[i] ? (want - acc) / segs[i] : 0;
            return {
                x: route[i].x + (route[i + 1].x - route[i].x) * t,
                y: route[i].y + (route[i + 1].y - route[i].y) * t,
            };
        }
        acc += segs[i];
    }
    return { ...route[route.length - 1] };
}

function routeMidpoint(route) {
    return routePointAt(route, 0.5);
}

// Breathing room (px) required around a label before it counts as "fits" — the label is drawn on a
// dark pill, so touching a node border already looks wrong.
const LABEL_FIT_MARGIN = 6;

// Where a label sits: centred on the wire (D2's default) or lifted clear of it. The three names are
// D2's own `labelPosition` values, the only placements it offers for a connection — there is no way
// to nudge a label by an arbitrary amount, which is why nudgeCollidingLabels can only ever try these.
const LABEL_MIDDLE = 'INSIDE_MIDDLE_CENTER';
const LABEL_ABOVE = 'OUTSIDE_TOP_CENTER';
const LABEL_BELOW = 'OUTSIDE_BOTTOM_CENTER';

// How far off the wire D2 draws a lifted label. Measured, not guessed: a 27px-tall label rendered at
// OUTSIDE_BOTTOM_CENTER moved its pill's centre from y=45.5 to y=61.5, i.e. half its height plus a
// few pixels of breathing room.
function labelLift(height) {
    return height / 2 + 3;
}

// The box a label occupies. `place` is one of the three positions above; the two lifted ones shift
// the box off the wire so a candidate can be scored BEFORE it is applied.
function labelBoxOf(conn, label, place = LABEL_MIDDLE, frac = 0.5) {
    const width = label?.labelWidth || 0;
    const height = label?.labelHeight || 0;
    const mid = width && height ? routePointAt(conn.route, frac) : null;
    if (!mid) return null;
    const halfW = width / 2 + LABEL_FIT_MARGIN;
    const halfH = height / 2 + LABEL_FIT_MARGIN;
    let cy = mid.y;
    if (place === LABEL_ABOVE) cy -= labelLift(height);
    else if (place === LABEL_BELOW) cy += labelLift(height);
    return { x0: mid.x - halfW, x1: mid.x + halfW, y0: cy - halfH, y1: cy + halfH };
}

// Total length of a route, used to decide WHICH of two clashing labels gives way: the one on the
// longer wire has more room around it and is the cheaper one to move.
function routeLength(route) {
    if (!Array.isArray(route) || route.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < route.length; i++) {
        total += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
    }
    return total;
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

// …but a container's own TITLE is still an obstacle. Its body must stay open (that is the whole
// point of a boundary), yet the strip of text along its top edge is as unreadable under a
// connection label as an icon is. This matters since the network boxes arrived: a VPC or subnet
// title carries the CIDR and the availability zone, so it is long and wide enough for an edge
// crossing the box to land right on it. D2 lays every container title out as INSIDE_TOP_CENTER and
// fills in labelWidth/labelHeight, so the strip is exact; anything positioned otherwise (a leaf's
// OUTSIDE_BOTTOM_CENTER name) is skipped — those shapes are already covered as whole boxes above.
function containerLabelBoxes(diagram) {
    const shapes = (diagram?.shapes || []).filter((s) => s?.id && s.pos);
    return shapes
        .filter((s) => shapes.some((o) => o !== s && o.id.startsWith(`${s.id}.`)))
        .filter((s) => s.labelPosition === 'INSIDE_TOP_CENTER' && s.labelWidth > 0 && s.labelHeight > 0)
        .map((s) => {
            const x0 = s.pos.x + (s.width - s.labelWidth) / 2;
            return { x0, x1: x0 + s.labelWidth, y0: s.pos.y, y1: s.pos.y + s.labelHeight };
        });
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
    const nodes = [...leafShapeBoxes(diagram), ...containerLabelBoxes(diagram)];
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
// otherwise turning step numbers on could overflow a gap sized only for the unnumbered form. Also
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
export async function renderDeployedDiagram(storedText) {
    // Steps are re-derived from the flow's shape at render time, never written back to the stored
    // diagram.d2 — so every diagram already on disk gets the structured numbering without being
    // regenerated, and what the model wrote stays intact.
    // Box titles are likewise re-wrapped at render time, never written back: a stored diagram with a
    // long VPC/subnet title gets the narrower two-line form without being regenerated.
    const diagramText = wrapBoxLabels(renumberSteps(storedText));
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

// Lift a label clear of the wire when it lands on top of another one. The layout is computed with the
// labels REMOVED so the diagram packs tight, which is exactly why two of them can end up in the same
// gap: nothing reserved room for either. The alternative — recompiling with the labels in place —
// fixes it but costs real width (measured: +786px on the two-zone sigil), while moving a label costs
// nothing at all, since it changes only where D2 draws the text.
//
// The rule: on a clash the label on the LONGER route gives way, because a long wire has more free
// space around it. It tries below, then above, and a side is only taken if the label lands clear of
// the things that would actually hide it — service icons, container titles and other labels. Wires
// do not count, since a label's opaque pill covers them. If neither side works for the long one, the
// short one is pushed the OTHER way instead, buying twice the separation. When nothing helps, both
// stay centred, so the worst case is exactly today's picture.
//
// One hard limit, from D2: it offers only these three placements — there is no "move by N pixels" —
// so the whole budget is about half a label's height each way. Lifting is always vertical, which is
// what matters here: the point is to pull two labels APART, and that works whichever way their wires
// happen to run. On a vertical run the label slides along its own wire rather than off it, but its
// opaque pill still covers the line, so the only thing that changes is the separation we came for.
export function nudgeCollidingLabels(diagram) {
    // A label needs a usable ROUTE as well as text: D2 can hand back a connection whose route is
    // missing or has a single point, and its box is then null. Filtering those out here is what keeps
    // the pair loop below from comparing against null — which threw, and a throw in this pass costs
    // the whole diagram, since _renderLabelViews catches it and falls back to a render that reports
    // an error to the user.
    const conns = (diagram?.connections || []).filter(
        (c) => c?.label && c.labelWidth && c.labelHeight && labelBoxOf(c, c)
    );
    if (conns.length < 2) return new Map();
    const obstacles = [...leafShapeBoxes(diagram), ...containerLabelBoxes(diagram)];
    const place = new Map(conns.map((c) => [c, LABEL_MIDDLE]));
    const frac = new Map(conns.map((c) => [c, 0.5]));
    // After applyLabels a connection carries its own label metrics, so it doubles as the `label`
    // argument labelBoxOf expects.
    const boxAt = (conn, p, f = frac.get(conn) ?? 0.5) => labelBoxOf(conn, conn, p, f);
    const boxes = new Map(conns.map((c) => [c, boxAt(c, LABEL_MIDDLE)]));

    // Is `conn`'s label free of everything else if placed at `p`, `f` of the way along its wire?
    const isClear = (conn, p, f) => {
        const box = boxAt(conn, p, f);
        if (!box) return false;
        if (obstacles.some((o) => boxesOverlap(box, o))) return false;
        for (const other of conns) {
            if (other === conn) continue;
            const otherBox = boxes.get(other);
            if (otherBox && boxesOverlap(box, otherBox)) return false;
        }
        // Crossing somebody else's WIRE is deliberately allowed: the stateviz prompt gives every
        // connection label an opaque dark pill (`style.fill: "#0d1117"`) precisely so it can sit over
        // a line and stay readable — labelCollisions counts that as "mild" for the same reason.
        // Vetoing it here made the pass refuse every candidate on a dense diagram and move nothing.
        return true;
    };

    const lift = (conn, sides) => {
        for (const side of sides) {
            if (isClear(conn, side, frac.get(conn))) {
                place.set(conn, side);
                boxes.set(conn, boxAt(conn, side));
                return true;
            }
        }
        return false;
    };

    // Last resort: walk the label along its OWN wire, away from the midpoint. Lifting can only move
    // it about half its own height, which is not enough when two labels sit almost exactly on top of
    // each other; sliding has the whole length of the wire to play with. Tried outward in steps so
    // the label stays as close to the middle of its arrow as it can while still being readable, and
    // never so far that it reaches an endpoint and reads as belonging to the node instead.
    const SLIDE_STEPS = [0.35, 0.65, 0.28, 0.72, 0.22, 0.78];
    const slide = (conn) => {
        for (const f of SLIDE_STEPS) {
            if (isClear(conn, LABEL_MIDDLE, f)) {
                frac.set(conn, f);
                boxes.set(conn, boxAt(conn, LABEL_MIDDLE, f));
                return true;
            }
        }
        return false;
    };

    // Deterministic: connections are walked in diagram order, so the same diagram always resolves
    // the same way.
    for (let i = 0; i < conns.length; i++) {
        for (let j = i + 1; j < conns.length; j++) {
            const a = conns[i], b = conns[j];
            if (place.get(a) !== LABEL_MIDDLE && place.get(b) !== LABEL_MIDDLE) continue;
            const boxA = boxes.get(a), boxB = boxes.get(b);
            if (!boxA || !boxB || !boxesOverlap(boxA, boxB)) continue;
            const [long, short] = routeLength(a.route) >= routeLength(b.route) ? [a, b] : [b, a];
            if (place.get(long) === LABEL_MIDDLE && lift(long, [LABEL_BELOW, LABEL_ABOVE])) continue;
            if (place.get(short) === LABEL_MIDDLE && lift(short, [LABEL_ABOVE, LABEL_BELOW])) continue;
            // Neither could step off the wire — slide the long one along it instead.
            if (frac.get(long) === 0.5 && slide(long)) continue;
            if (frac.get(short) === 0.5) slide(short);
        }
    }

    for (const [conn, p] of place) conn.labelPosition = p;

    // D2 draws every label at the midpoint no matter what, so a slide has to be applied to the
    // finished SVG. Hand back the offset for each one that moved, keyed by the connection id (which
    // is exactly the group class the renderer emits, base64-encoded).
    const slides = new Map();
    for (const [conn, f] of frac) {
        if (f === 0.5) continue;
        const from = routePointAt(conn.route, 0.5);
        const to = routePointAt(conn.route, f);
        if (from && to) slides.set(conn.id, { dx: to.x - from.x, dy: to.y - from.y });
    }
    return slides;
}

async function _renderLabelViews(diagramText, hasSteps) {
    // Without step numbers the numbered view is identical to the plain one — don't render it.
    const views = hasSteps ? LABEL_VIEWS : LABEL_VIEWS.slice(0, 1);
    // Which connections were declared backwards on purpose; carried through every layout compile so
    // the arrowheads can be flipped back after ELK has run.
    const markers = edgeMarkerFlags(diagramText);
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
        let layout = await compileLaidOut(stripLabels(diagramText), markers);
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
        // ELK gives every labelled edge its own dummy layer, and layers are global, so reserving for
        // SOME edges shifts whichever branches happen to contain one. On a multi-AZ diagram that
        // pulls a resource's copies out of the column they must share to read as one service —
        // measured on the two-zone sigil: reserving just the misfits left the public subnets 308px
        // apart, while reserving none or all of them put them dead in line.
        //
        // Of those two, reserving NONE is strictly better: same alignment, and 1344px of content
        // instead of 2045px. That is the layout this pipeline is built around anyway — lay out
        // label-free so ELK packs tight, then fit the labels into the gaps. So a diagram with copies
        // simply keeps its base layout. A diagram without copies has no mirrored columns to protect,
        // so there the reservation still earns its keep and is left alone.
        const hasReplicas = diagramText.includes('__');
        if (stuck.misfits.size && !hasReplicas) {
            layout = await compileLaidOut(mapEdgeLabels(diagramText, (parts, i) =>
                (stuck.misfits.has(i) ? toD2Label(stuck.widest[i]?.label) : '')), markers);
            // Geometry moved — re-pick on the layout that actually ships.
            picks = views.map((_, v) => chooseLabelForms(layout.diagram, singleHarvests[v], wrappedHarvests[v]));
        }

        // 4. Render each view onto that one geometry. Clone per view so the injected labels of one
        //    view can't leak into the next.
        const out = { hasSteps, error: null };
        for (let i = 0; i < views.length; i++) {
            const diagram = structuredClone(layout.diagram);
            if (!applyLabels(diagram, picks[i].chosen)) throw new Error('label injection failed');
            // Per view, and on this view's own clone: the two views carry different text (with and
            // without the step number), so they have different widths and different clashes.
            const slides = nudgeCollidingLabels(diagram);
            out[views[i][0]] = await renderCompiled({ diagram, renderOptions: layout.renderOptions, slides });
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
    const action = await _doRender(composeLabel(diagramText, { steps: false }));
    const actionSteps = hasSteps
        ? await _doRender(composeLabel(diagramText, { steps: true }))
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
// Which edge indices the prompt declared backwards, read from the ORIGINAL diagram text. It has to
// be computed there and carried in: by compile time `composeLabel` has already collapsed each label
// to the text the canvas shows, so the `back` marker is long gone from `conn.label`. The index is
// the same `edgeIndex` mapEdgeLabels hands out, which is the order the compiled connections come
// back in — the correspondence harvestLabels already relies on.
function edgeMarkerFlags(diagramText) {
    const back = [];
    const both = [];
    mapEdgeLabels(diagramText, (parts) => {
        back.push(isBackEdgeLabel(parts));
        both.push(isBothEndsLabel(parts));
        return parts.join(LABEL_SEP);
    });
    return { back, both };
}

// Draw a head at the SOURCE end too, for the connections whose whole point is what comes back.
// srcArrow/dstArrow are the arrowhead NAMES D2 renders, not booleans — a plain edge comes back as
// src `"none"` / dst `"triangle"` — so the source end is given the same head the destination already
// carries, and the diagram keeps one arrowhead style throughout.
const DEFAULT_ARROWHEAD = 'triangle';
function showBothArrows(diagram, flags) {
    if (!flags?.some(Boolean)) return;
    (diagram?.connections || []).forEach((conn, i) => {
        if (!flags[i]) return;
        conn.srcArrow = conn.dstArrow && conn.dstArrow !== 'none' ? conn.dstArrow : DEFAULT_ARROWHEAD;
    });
}

// Put the arrowhead back where the traffic really goes. A `back` connection was declared the wrong
// way round only so the layout would keep its subnet in the right column (see prompt.md, BACKWARD
// EDGES); left alone it would be drawn pointing at the wrong end, which is a worse lie than the
// misalignment it fixes. The route is NOT touched — it is the same line either way, and `src`/`dst`
// stay as ELK set them so every geometry pass keeps working on the real endpoints. Only the head
// moves to the other end.
function flipBackEdgeArrows(diagram, flags) {
    if (!flags?.some(Boolean)) return;
    (diagram?.connections || []).forEach((conn, i) => {
        if (!flags[i]) return;
        const { srcArrow, dstArrow } = conn;
        conn.srcArrow = dstArrow;
        conn.dstArrow = srcArrow;
    });
}

async function compileLaidOut(text, markers) {
    const d2 = await getD2Renderer();
    // ELK layout engine: orthogonal edge routing and tighter, more compact placement than
    // dagre — much cleaner for the left-to-right AWS architecture diagrams this app produces.
    // (ELK does NOT center connection endpoints on its own — see centerConnectionEndpoints.)
    const compiled = await d2.compile(text, { layout: 'elk' });
    // Order matters: give a node its real size back first (ELK inflates a crowded one, which both
    // drops its label and puts its edges nowhere near the icon), then decide each endpoint's SIDE,
    // then space each side's final set evenly.
    shrinkPortInflatedNodes(compiled.diagram);
    spreadCrowdedAttachments(compiled.diagram);
    centerConnectionEndpoints(compiled.diagram);
    orthogonalizeConnectionRoutes(compiled.diagram);
    flipBackEdgeArrows(compiled.diagram, markers?.back);
    showBothArrows(compiled.diagram, markers?.both);
    return compiled;
}

// Render an already-compiled+laid-out diagram to an embeddable SVG string. Unqueued (see above).
// Blank frame D2 draws around the whole SVG, outside even the "AWS Cloud" boundary. Its default is
// 100px a side, which on a real diagram measured 2045x1030 of content inside a 2227x1282 image —
// ~182x252px of nothing. The canvas has its own padding and the export wraps the SVG itself, so a
// thin frame is all this needs to keep strokes from touching the edge.
const SVG_PAD = 24;

// Move the labels that nudgeCollidingLabels decided to slide. D2 always draws a connection label at
// the midpoint of its route and offers no way to shift it along the wire, so the move is made here,
// on the finished SVG: each label is a `<rect>` pill plus a `<text>`, both inside the connection's
// own `<g>`, whose class is the base64 of the connection id. Translating those two is enough — the
// pill is painted after the line, so it keeps covering it wherever it lands.
//
// The `mask` on that connection's path goes with them: D2 punches a gap in the line where the label
// USED to be, and left alone that gap would show as an unexplained break in the middle of the wire.
export function applyLabelSlides(svg, slides) {
    if (!slides?.size) return svg;
    const wanted = new Map();
    for (const [id, offset] of slides) {
        // The renderer HTML-escapes the id before encoding it, so `->` arrives as `-&gt;`.
        wanted.set(Buffer.from(String(id).replace(/>/g, '&gt;'), 'utf8').toString('base64'), offset);
    }
    return svg.replace(/<g class="([A-Za-z0-9+/=]+)">([\s\S]*?)<\/g>/g, (whole, cls, body) => {
        const offset = wanted.get(cls);
        if (!offset) return whole;
        const shift = ` transform="translate(${offset.dx.toFixed(2)},${offset.dy.toFixed(2)})"`;
        const moved = body
            .replace(/<(rect|text)\b(?![^>]*\btransform=)/g, `<$1${shift}`)
            .replace(/(<path\b[^>]*?)\s+mask="[^"]*"/g, '$1');
        return `<g class="${cls}">${moved}</g>`;
    });
}

async function renderCompiled({ diagram, renderOptions, slides }) {
    const d2 = await getD2Renderer();
    // themeID 200 = "Dark Mumford": dark defaults so labels and edges are light on the
    // app's dark canvas. Node/container fills are still set explicitly by the prompts.
    const rawSvg = await d2.render(diagram, { ...renderOptions, themeID: 200, pad: SVG_PAD });
    const svg = applyLabelSlides(typeof rawSvg === 'string' ? rawSvg : String(rawSvg), slides);
    return prepareSvgForEmbed(svg);
}

async function _doRender(diagramText) {
    const text = (diagramText ?? '').trim();
    if (!text) {
        return { svg: '', error: null };
    }

    try {
        return { svg: await renderCompiled(await compileLaidOut(text, edgeMarkerFlags(text))), error: null };
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

// How many connection endpoints one side of a node may carry before the overflow is pushed onto the
// perpendicular sides. On a `direction: right` diagram ELK attaches EVERY edge of a node to the same
// side, so a service that talks to six others gets six endpoints spread along one icon edge — a comb
// of near-parallel lines a few pixels apart that then run together across the whole canvas. Three is
// where a side still reads as separate arrows rather than hatching.
const MAX_PER_SIDE = 3;

// Which perpendicular side an endpoint would rather leave from, judged by where its OTHER end sits:
// a partner above the node is reached most directly by leaving from the top, one below by the
// bottom. A partner level with the node has no better side than the one it already uses, so it is
// not a candidate — moving it would add a detour instead of removing one.
function preferredSpillSide(far, shape) {
    if (far.y < shape.pos.y) return 'top';
    if (far.y > shape.pos.y + shape.height) return 'bottom';
    return null;
}

// Lanes an arrow can take once it has left the top or bottom of its node. Every arrow leaving the
// same side is handed a DIFFERENT one: share a lane and two arrows draw the same horizontal line on
// top of each other, which reads as a single wire and hides one of the two connections entirely.
const LANE_STEP = 32;
const LANE_COUNT = 5;
const SPILL_LANES = Array.from({ length: LANE_COUNT }, (_, i) => (i + 1) * LANE_STEP);

// How far short of the partner the path turns in, so the last leg runs INTO its face. Several
// offsets, for the same reason there are several lanes: every partner in one column would otherwise
// be met by a turn at the SAME x, stacking those descents on top of each other (measured: three
// vertical pairs at 0px apart, overlapping for up to 305px).
const SPILL_APPROACHES = [40, 76, 112, 148, 184];

// Two parallel lines closer than this, running alongside for at least that far, read as ONE line —
// so one of the two connections simply disappears for the reader. No rebuilt path may do it.
const LINE_SEPARATION = 20;
const LINE_SHARED = 60;
// Below this a segment is a jog between bends, not a run anyone can confuse with another.
const TRACK_MIN = 40;

// A route's long straight runs, as {o: 'H'|'V', c: the constant coordinate, lo, hi}. Short and
// diagonal pieces are ignored: they carry no risk of being mistaken for a neighbour.
function longRuns(points) {
    const out = [];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (Math.abs(a.x - b.x) <= ROUTE_EPS && Math.abs(a.y - b.y) >= TRACK_MIN) {
            out.push({ o: 'V', c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
        } else if (Math.abs(a.y - b.y) <= ROUTE_EPS && Math.abs(a.x - b.x) >= TRACK_MIN) {
            out.push({ o: 'H', c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
        }
    }
    return out;
}

function runsClash(a, b) {
    return a.o === b.o && Math.abs(a.c - b.c) <= LINE_SEPARATION
        && Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) >= LINE_SHARED;
}

// One candidate path from `point` (already sitting on `side` of its own node) to `far`.
//
// `laneGap` of 0 is the plain L: straight out to the partner's height, then across into it. Anything
// else runs out to a lane that many pixels clear of the node first, crosses there, and only then
// turns in — which is what finds room in a packed diagram where the plain L is blocked.
//
// `farHorizontal` says the partner's own endpoint sits on its LEFT or RIGHT face, so the arrow has to
// arrive along the horizontal. Getting this wrong is what made the earlier version drop its last leg
// vertically onto the partner's side: the line slid down the icon's border and the arrowhead landed
// on the edge pointing the wrong way. With it, the path drops to the partner's height EARLY — a full
// APPROACH before it — and comes in level.
function spillPath(point, far, side, laneGap, farHorizontal, approach) {
    if (!laneGap) return [point, { x: point.x, y: far.y }, far];
    const away = side === 'top' ? -1 : 1;
    const laneY = point.y + away * laneGap;
    // A lane past the partner is the plain L with a pointless kink in it.
    if (away < 0 ? laneY < far.y : laneY > far.y) return null;
    const pts = [point, { x: point.x, y: laneY }];
    const toward = far.x >= point.x ? 1 : -1;
    const turnX = far.x - toward * approach;
    if (farHorizontal && toward * (turnX - point.x) > 0) {
        pts.push({ x: turnX, y: laneY }, { x: turnX, y: far.y });
    } else {
        pts.push({ x: far.x, y: laneY });
    }
    pts.push(far);
    return pts;
}

// A point list as drawable legs, with any zero-length step (a lane that already sat at the partner's
// height, a turn that landed on the departure column) dropped.
function pathLegs(points) {
    const kept = points.filter((p, i) => i === 0
        || Math.abs(p.x - points[i - 1].x) > ROUTE_EPS || Math.abs(p.y - points[i - 1].y) > ROUTE_EPS);
    return kept.slice(1).map((p, i) => [kept[i], p]);
}

// Give a node back the size it should have drawn at.
//
// ELK sizes a node to fit its edge attachment points, so a service with six connections on one side
// comes back 128x240 instead of 128x128 (measured: every node with <=3 edges stays square, both
// six-edge nodes inflate). D2 draws `shape: image` into that whole box with no preserveAspectRatio,
// so the 128px icon renders centred in it and everything hung off the box drifts: ~56px of dead air
// under the icon, the service NAME pushed that far down (every other node's sits 23px under its
// icon), and any endpoint on the top/bottom edge landing nowhere near the picture the reader sees.
//
// Shrinking back to square around the SAME CENTRE leaves the icon exactly where ELK put it and only
// takes the padding away — and it hands the spill pass ~112px of newly free space to route through,
// which is the difference between it finding a lane and giving up.
//
// The test for "inflated" is structural, so it needs no D2 field: a LEAF shape (same rule as
// leafShapeBoxes), TALLER than it is wide, carrying more endpoints on one vertical side than the cap.
// A box that is WIDER than tall is a real labelled box (a service with no icon in the catalogue) and
// is never touched.
export function shrinkPortInflatedNodes(diagram) {
    const shapeById = shapeIndexById(diagram);
    if (!shapeById.size) return;
    const shapes = [...shapeById.values()];
    const isLeaf = (s) => !shapes.some((o) => o !== s && o.id.startsWith(`${s.id}.`));

    // Deliberately more forgiving than sideOf's half-pixel: on some compiles ELK leaves an endpoint a
    // couple of pixels off the box (measured 2.67px on one replica, which is why that node kept its
    // padding while its twin lost it). Whichever edge is nearest wins, so long as it is close — a few
    // pixels cannot confuse two sides of a 128px node, and the endpoints are snapped exactly onto the
    // new box below, which leaves the later passes matching them on the nose again.
    const NEAR = 6;
    const nearestSide = (p, s) => {
        const d = { left: Math.abs(p.x - s.pos.x), right: Math.abs(p.x - (s.pos.x + s.width)),
            top: Math.abs(p.y - s.pos.y), bottom: Math.abs(p.y - (s.pos.y + s.height)) };
        const best = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
        return d[best] <= NEAR ? best : null;
    };

    // Endpoints per shape, with the adjacent route point so a stub can be carried along.
    const touching = new Map(); // shapeId -> [{ point, adjacent, otherEnd }]
    for (const conn of diagram.connections || []) {
        const route = conn.route;
        if (!route || route.length < 2) continue;
        const last = route.length - 1;
        for (const [id, i, adj] of [[conn.src, 0, 1], [conn.dst, last, last - 1]]) {
            if (!shapeById.has(id)) continue;
            if (!touching.has(id)) touching.set(id, []);
            touching.get(id).push({ point: route[i], adjacent: route[adj], otherEnd: route[i === 0 ? last : 0] });
        }
    }

    for (const shape of shapes) {
        if (shape.height <= shape.width || !isLeaf(shape)) continue;
        const ends = touching.get(shape.id) || [];
        const perSide = new Map();
        for (const e of ends) {
            const side = nearestSide(e.point, shape);
            if (side === 'left' || side === 'right') perSide.set(side, (perSide.get(side) || 0) + 1);
        }
        if (![...perSide.values()].some((n) => n > MAX_PER_SIDE)) continue;

        const top = shape.pos.y + (shape.height - shape.width) / 2;
        const bottom = top + shape.width;
        for (const { point, adjacent, otherEnd } of ends) {
            const side = nearestSide(point, shape);
            if (!side) continue;
            // Keep where the endpoint sat ALONG its side (as a fraction) so the lines keep their
            // order and none of them crosses another on the way in; centerConnectionEndpoints
            // re-spaces them evenly straight after this anyway.
            let target;
            if (side === 'left' || side === 'right') {
                const frac = (point.y - shape.pos.y) / shape.height;
                target = { axis: 'y', value: top + shape.width * Math.min(1, Math.max(0, frac)) };
                // Snap it exactly onto the edge too, so the strict sideOf the later passes use
                // recognises it again even when ELK had left it a couple of pixels adrift.
                point.x = side === 'left' ? shape.pos.x : shape.pos.x + shape.width;
            } else {
                target = { axis: 'y', value: side === 'top' ? top : bottom };
            }
            if (adjacent !== otherEnd && Math.abs(adjacent[target.axis] - point[target.axis]) <= ROUTE_EPS) {
                adjacent[target.axis] = target.value;
            }
            point[target.axis] = target.value;
        }
        shape.pos.y = top;
        shape.height = shape.width;
    }
}

// Take the overflow off a crowded node side and hang it on the perpendicular ones, so a service with
// many neighbours fans out around itself instead of combing every line off one edge.
//
// Runs BEFORE centerConnectionEndpoints, which then spaces each side's FINAL set evenly — this pass
// only decides WHICH side an endpoint leaves from, never where along it. A spilled connection is
// reduced to its two endpoints; orthogonalizeConnectionRoutes turns that into the clean L a vertical
// departure implies. ELK's own bends are dropped for exactly those edges (they were computed for a
// horizontal departure and would double the line back to the node's old height), which is why a move
// is vetoed whenever its predicted L would cross an icon or a container's title strip: the worst case
// then is today's crowded-but-correct picture, never a line cutting through a node.
export function spreadCrowdedAttachments(diagram) {
    const shapeById = shapeIndexById(diagram);
    if (!shapeById.size) return;

    // Endpoints grouped by the side they currently attach to. The point OBJECTS are kept (not
    // indices): a spill rewrites conn.route, and an index taken before that would go stale.
    const groups = new Map(); // `${shapeId}\x00${side}` -> [{ conn, point, far, shape }]
    for (const conn of diagram.connections || []) {
        const route = conn.route;
        if (!route || route.length < 2 || conn.src === conn.dst) continue;
        const head = route[0], tail = route[route.length - 1];
        for (const [shapeId, point, far] of [[conn.src, head, tail], [conn.dst, tail, head]]) {
            const shape = shapeById.get(shapeId);
            if (!shape) continue;
            const side = sideOf(point, shape);
            if (!side) continue;
            const key = `${shapeId}\x00${side}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ conn, point, far, shape });
        }
    }

    // A SERVICE ICON is the only thing a spilled line may never cross — that is always wrong, and it
    // is the one veto kept here. Container titles and borders are fair game: these edges already
    // cross container borders everywhere, containers stack vertically with a title on each top edge,
    // and treating those as obstacles vetoed nearly every move (measured: 1 of 3 spills in one zone,
    // 0 in the other) for damage a reader would not even notice.
    const icons = leafShapeBoxes(diagram);
    // A spilled edge always leaves its own node and lands on its partner, so neither of those two
    // boxes counts as something it "crosses".
    const clearOf = (legs, shape, far) => {
        const own = { x0: shape.pos.x, x1: shape.pos.x + shape.width, y0: shape.pos.y, y1: shape.pos.y + shape.height };
        return !icons.some((box) => {
            if (boxesOverlap(box, own)) return false;
            if (far.x >= box.x0 && far.x <= box.x1 && far.y >= box.y0 && far.y <= box.y1) return false;
            return legs.some(([a, b]) => segmentHitsBox(a, b, box));
        });
    };
    // Which face of the PARTNER its own endpoint sits on. A left/right face has to be met head-on;
    // anything else (or a partner this cannot resolve) keeps the vertical arrival.
    const arrivesHorizontally = (conn, far) => {
        const partner = shapeById.get(conn.route[0] === far ? conn.src : conn.dst);
        const side = partner && sideOf(far, partner);
        return side === 'left' || side === 'right';
    };

    // Every long straight run already on the canvas, so a rebuilt path can be kept off them. Seeded
    // from ELK's own routes too: landing a lane 20px from a line ELK drew reads just as badly as
    // landing on a sibling's.
    const tracks = [];
    for (const conn of diagram.connections || []) {
        if (Array.isArray(conn.route)) for (const run of longRuns(conn.route)) tracks.push({ conn, run });
    }
    const laysOnAnother = (legs, conn) => legs.some(([a, b]) => {
        const [run] = longRuns([a, b]);
        return run && tracks.some((t) => t.conn !== conn && runsClash(t.run, run));
    });

    // The first path that crosses no icon AND lies on top of no existing line, trying `preferred`
    // lanes before the rest and every turn-in offset within each. Returns the legs plus the lane that
    // won, so a sibling can be steered away from it.
    const findPath = (point, far, side, shape, farHorizontal, conn, preferred = []) => {
        const lanes = [0, ...preferred, ...SPILL_LANES.filter((g) => !preferred.includes(g))];
        for (const laneGap of lanes) {
            for (const approach of SPILL_APPROACHES) {
                const points = spillPath(point, far, side, laneGap, farHorizontal, approach);
                if (!points) continue;
                const legs = pathLegs(points);
                if (!legs.length || !clearOf(legs, shape, far)) continue;
                if (laysOnAnother(legs, conn)) continue;
                return { legs, laneGap };
            }
            if (!laneGap) continue; // the plain L has no turn-in to vary
        }
        return null;
    };

    // Swap a connection's runs in the registry for the ones it is about to draw.
    const retrack = (conn, legs) => {
        for (let i = tracks.length - 1; i >= 0; i--) if (tracks[i].conn === conn) tracks.splice(i, 1);
        for (const [a, b] of legs) for (const run of longRuns([a, b])) tracks.push({ conn, run });
    };

    const moved = new Map(); // side -> [{ point, far, shape }], filled per crowded group
    for (const [key, attachments] of groups) {
        if (attachments.length <= MAX_PER_SIDE) continue;
        const side = key.split('\x00')[1];
        // Only the sides that run along the flow spill. A crowded top/bottom is rare, and pushing it
        // sideways would fight the left-to-right reading the whole layout is built on.
        if (side !== 'left' && side !== 'right') continue;

        // Most extreme partner first, so the arrows that gain the most from leaving vertically are
        // the ones that get to.
        const wanting = (want, sort) => attachments
            .filter((a) => preferredSpillSide(a.far, a.shape) === want)
            .sort(sort);
        const queues = {
            top: wanting('top', (a, b) => a.far.y - b.far.y),
            bottom: wanting('bottom', (a, b) => b.far.y - a.far.y),
        };

        // Alternate top/bottom so the overflow lands balanced instead of recreating the same crowd
        // one side over, and stop as soon as this side is back under the cap. A candidate with no
        // clear lane is SKIPPED, not fatal: the next one along gets the slot.
        let need = attachments.length - MAX_PER_SIDE;
        const taken = { top: [], bottom: [] };
        for (let turn = 0; need > 0 && (queues.top.length || queues.bottom.length); turn++) {
            const to = turn % 2 === 0 ? 'top' : 'bottom';
            const from = queues[to];
            if (!from.length || taken[to].length >= MAX_PER_SIDE) {
                if (!queues.top.length && !queues.bottom.length) break;
                if (taken.top.length >= MAX_PER_SIDE && taken.bottom.length >= MAX_PER_SIDE) break;
                continue;
            }
            const a = from.shift();
            // Probe from the side's midpoint. The final slot is only known once this side's whole set
            // is, and the path is searched again then — this just drops the hopeless ones early.
            const probe = { x: a.shape.pos.x + a.shape.width / 2,
                y: to === 'top' ? a.shape.pos.y : a.shape.pos.y + a.shape.height };
            if (!findPath(probe, a.far, to, a.shape, arrivesHorizontally(a.conn, a.far), a.conn)) continue;
            taken[to].push(a);
            need--;
        }

        for (const to of ['top', 'bottom']) {
            for (const a of taken[to]) {
                if (!moved.has(`${a.shape.id}\x00${to}`)) moved.set(`${a.shape.id}\x00${to}`, []);
                moved.get(`${a.shape.id}\x00${to}`).push(a);
            }
        }
    }

    for (const [key, list] of moved) {
        const side = key.split('\x00')[1];
        const shape = list[0].shape;
        const edgeY = side === 'top' ? shape.pos.y : shape.pos.y + shape.height;
        // Order along the edge decides whether these lines cross each other: they all run vertically
        // clear of the node and then turn horizontally at their partner's height, so the one turning
        // FURTHEST from the node has to be the outermost — otherwise its long horizontal leg cuts
        // across its neighbours' vertical ones. Re-sorted here rather than trusted from the queues,
        // since a node crowded on BOTH flow sides contributes two already-sorted runs to this list.
        list.sort((a, b) => (side === 'top' ? a.far.y - b.far.y : b.far.y - a.far.y));
        // The arrow leaving the LEFTMOST slot is the one whose partner is furthest out, so it takes
        // the OUTERMOST lane: its long horizontal leg then passes clear above (or below) every
        // sibling's vertical one instead of cutting across them.
        const usedLanes = new Set();
        list.forEach((a, i) => {
            const x = shape.pos.x + shape.width * ((i + 1) / (list.length + 1));
            const wanted = SPILL_LANES[Math.min(SPILL_LANES.length - 1, list.length - 1 - i)];
            const preferred = [wanted, ...SPILL_LANES.filter((g) => g !== wanted && !usedLanes.has(g))];
            // Search again at the slot this endpoint actually gets: the probe ran from the side's
            // midpoint, and a lane that was clear there can be blocked a few pixels along.
            const path = findPath({ x, y: edgeY }, a.far, side, shape,
                arrivesHorizontally(a.conn, a.far), a.conn, preferred);
            if (!path) return;
            usedLanes.add(path.laneGap);
            retrack(a.conn, path.legs);
            const isHead = a.conn.route[0] === a.point;
            a.point.x = x;
            a.point.y = edgeY;
            // The legs run point -> ... -> far; every leg's end except the last is a bend. Rebuild the
            // route around the SAME endpoint objects, since centerConnectionEndpoints mutates them
            // next and the far end must keep whatever ELK gave it.
            const bends = path.legs.slice(0, -1).map(([, end]) => routePoint(a.point, end.x, end.y));
            a.conn.route = isHead
                ? [a.point, ...bends, a.far]
                : [a.far, ...bends.reverse(), a.point];
        });
    }
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
    const groups = new Map(); // `${shapeId}\x00${side}` -> [{ point, adjacent, axis, orderVal }]
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
            const key = `${shapeId}\x00${side}`;
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
