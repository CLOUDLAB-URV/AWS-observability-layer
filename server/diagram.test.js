'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renumberSteps, mapEdgeLabels, wrapLabel, wrapBoxLabels, composeLabel, nudgeCollidingLabels, applyLabelSlides, spreadCrowdedAttachments, shrinkPortInflatedNodes, isBothEndsLabel, isBackEdgeLabel } from './diagram.js';

const STYLE = '{ style.stroke: "#e6edf3"; style.stroke-width: 2 }';

// Build a diagram from `[src, dst, "<step> || <action>"]` rows, in the shape the stateviz prompt
// mandates: nodes first, connections one per line at the top level.
function d2(rows) {
    const nodes = [...new Set(rows.flatMap(([src, dst]) => [src, dst]))]
        .map((id) => `${id}: "Node" { shape: image }`)
        .join('\n');
    const edges = rows.map(([src, dst, label]) => `${src} -> ${dst}: "${label}" ${STYLE}`);
    return `direction: right\n\n${nodes}\n\n${edges.join('\n')}\n`;
}

// The step segment of every edge label, in source order.
function steps(diagramText) {
    const out = [];
    mapEdgeLabels(diagramText, (parts) => { out.push(parts[0]); return parts.join(' || '); });
    return out;
}

test('a linear flow keeps flat numbering', () => {
    const src = d2([
        ['browser', 'aws.api', '1 || HTTPS request'],
        ['aws.api', 'aws.fn', '2 || GET /orders'],
        ['aws.fn', 'aws.table', '3 || Read/write orders'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['1', '2', '3']);
});

test('a real split gives each branch its own sub-level', () => {
    // The "Spacing test" sigil: the API GW fans out to three lambdas, and all three carry on.
    const src = d2([
        ['browser', 'aws.cdn', '1 || Request'],
        ['aws.cdn', 'aws.apigw', '2 || Forward request'],
        ['aws.apigw', 'aws.orders_fn', '3 || POST /api/orders'],
        ['aws.apigw', 'aws.users_fn', '4 || GET /api/users/{id}'],
        ['aws.apigw', 'aws.payments_fn', '5 || POST /api/payments/checkout'],
        ['aws.orders_fn', 'aws.orders_db', '6 || Read/write orders'],
        ['aws.orders_fn', 'aws.events_bus', '7 || Publish order event'],
        ['aws.users_fn', 'aws.users_db', '8 || Query users'],
        ['aws.payments_fn', 'aws.payments_queue', '9 || Send payment message'],
        ['aws.payments_queue', 'aws.settle_fn', '10 || Consume payment message'],
        ['aws.settle_fn', 'aws.events_bus', '11 || Publish settlement event'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), [
        '1', '2',
        '3', '4', '5',
        '3.1', '3.2', // inside the orders branch
        '4.1',        // inside the users branch
        '5.1', '5.2', '5.3', // the payments branch stays linear at its own level
    ]);
});

test('a fan-out whose branches end there is NOT a split — numbering stays flat', () => {
    // One lambda writing to a table and publishing an event is two outputs of the same
    // functionality, not two functionalities.
    const src = d2([
        ['browser', 'aws.api', '1 || HTTPS request'],
        ['aws.api', 'aws.fn', '2 || GET/POST /orders'],
        ['aws.fn', 'aws.table', '3 || Read/write orders'],
        ['aws.fn', 'aws.topic', '4 || Publish order-notifications'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['1', '2', '3', '4']);
});

test('only one branch carrying on is not enough to open a level', () => {
    const src = d2([
        ['browser', 'aws.apigw', '1 || HTTPS request'],
        ['aws.apigw', 'aws.fn', '2 || POST /orders'],
        ['aws.apigw', 'aws.assets', '3 || GET /assets'],
        ['aws.fn', 'aws.table', '4 || Read/write orders'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['1', '2', '3', '4']);
});

test('nesting never goes past one dot', () => {
    // orders_fn splits again inside branch 3; those edges stay at the branch's own level.
    const src = d2([
        ['aws.apigw', 'aws.orders_fn', '1 || POST /orders'],
        ['aws.apigw', 'aws.users_fn', '2 || GET /users'],
        ['aws.orders_fn', 'aws.queue', '3 || Send message'],
        ['aws.orders_fn', 'aws.db', '4 || Read/write orders'],
        ['aws.users_fn', 'aws.users_db', '5 || Query users'],
        ['aws.queue', 'aws.worker', '6 || Consume message'],
        ['aws.db', 'aws.archive', '7 || Archive rows'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['1', '2', '1.1', '1.2', '2.1', '1.3', '1.4']);
});

test('branches are walked in the order the model numbered them', () => {
    // Same topology, but the model declared the users branch first and numbered it second.
    const src = d2([
        ['aws.apigw', 'aws.users_fn', '2 || GET /users'],
        ['aws.apigw', 'aws.orders_fn', '1 || POST /orders'],
        ['aws.users_fn', 'aws.users_db', '4 || Query users'],
        ['aws.orders_fn', 'aws.orders_db', '3 || Read/write orders'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['2', '1', '2.1', '1.1']);
});

test('a disconnected flow continues at the top level', () => {
    const src = d2([
        ['browser', 'aws.api', '1 || HTTPS request'],
        ['aws.api', 'aws.fn', '2 || GET /orders'],
        ['aws.cron', 'aws.batch_fn', '3 || Invoke'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['1', '2', '3']);
});

test('a cycle numbers every edge exactly once', () => {
    const src = d2([
        ['aws.a', 'aws.b', '1 || Invoke'],
        ['aws.b', 'aws.c', '2 || Invoke'],
        ['aws.c', 'aws.a', '3 || Invoke'],
    ]);
    assert.deepEqual(steps(renumberSteps(src)), ['1', '2', '3']);
});

test('an edge with no step number leaves the whole diagram untouched', () => {
    // The oldest stored form, `"<action> || <protocol>"` — nothing to renumber.
    const src = d2([
        ['browser', 'aws.api', 'HTTPS request || HTTPS :443'],
        ['aws.api', 'aws.fn', 'GET /orders || HTTPS :443'],
    ]);
    assert.equal(renumberSteps(src), src);
});

test('a connection this cannot parse leaves the whole diagram untouched', () => {
    // A chained `a -> b -> c` never matches EDGE_LINE, so the edge count disagrees with the label
    // count and the diagram keeps the numbers it came with.
    const src = `direction: right

aws.a -> aws.b: "1 || Invoke" ${STYLE}
aws.b -> aws.c -> aws.d: "2 || Invoke" ${STYLE}
`;
    assert.equal(renumberSteps(src), src);
});

test('a diagram with no segmented labels is returned as-is', () => {
    const src = 'direction: right\n\norders_api -> orders_queue\n';
    assert.equal(renumberSteps(src), src);
});

test('a trailing protocol segment survives renumbering', () => {
    const src = d2([
        ['browser', 'aws.api', '1 || Request || HTTPS :443'],
        ['aws.api', 'aws.fn', '2 || GET /orders || HTTPS :443'],
    ]);
    assert.match(renumberSteps(src), /"1 \|\| Request \|\| HTTPS :443"/);
    assert.match(renumberSteps(src), /"2 \|\| GET \/orders \|\| HTTPS :443"/);
});

test('wrapLabel never orphans a step number on the first line', () => {
    assert.equal(wrapLabel('3. Publish order event'), '3. Publish\\norder event');
    assert.equal(wrapLabel('3.1 Publish order event'), '3.1 Publish\\norder event');
});

// --- wrapBoxLabels (VPC / subnet box titles) --------------------------------------------------

test('wrapBoxLabels breaks at the separator that balances the two lines, not the first one', () => {
    const src = 'aws.v.s: "SUBNET · 10.0.1.0/24 · us-east-1a" {';
    // Splitting after "SUBNET" gives 6/24; after the CIDR gives 20/10 — the second is narrower.
    assert.equal(wrapBoxLabels(src), 'aws.v.s: "SUBNET · 10.0.1.0/24\\nus-east-1a" {');
});

test('wrapBoxLabels leaves a title that is under the threshold on one line', () => {
    const src = 'aws.v: "VPC · 10.0.0.0/16" {';
    assert.equal(wrapBoxLabels(src), src, '17 chars is not worth a second line');
});

test('wrapBoxLabels never touches an edge label, even one containing the box separator', () => {
    const src = `aws.a -> aws.b: "3 || Query orders · fast" ${STYLE}`;
    assert.equal(wrapBoxLabels(src), src, 'the || sentinel marks it as an edge, hands off');
});

test('wrapBoxLabels is idempotent — an already-broken title is left alone', () => {
    const once = wrapBoxLabels('aws.v.s: "SUBNET · 10.0.1.0/24 · us-east-1a" {');
    assert.equal(wrapBoxLabels(once), once);
});

test('wrapBoxLabels leaves a diagram with no box separator byte-identical', () => {
    const src = [
        'direction: right',
        'aws: "AWS Cloud (us-east-1)" {',
        '  compute: "COMPUTE" {',
        '    fn: "Lambda" { shape: image; icon: "/aws-icons/compute/lambda.svg" }',
        '  }',
        '}',
        `aws.compute.fn -> aws.compute.fn2: "1 || Invoke" ${STYLE}`
    ].join('\n');
    assert.equal(wrapBoxLabels(src), src);
});

test('wrapBoxLabels rewrites every box in a real diagram and nothing else', () => {
    const src = [
        'aws: "AWS Cloud (us-east-1)" {',
        '  vpc_0abc: "VPC · 10.0.0.0/16" {',
        '    subnet_1a2b: "SUBNET · 10.0.1.0/24 · us-east-1a" {',
        '      alb_web: "ALB" { shape: image; icon: "/aws-icons/networking/elb.svg" }',
        '    }',
        '    subnet_3c4d: "SUBNET · 10.0.2.0/24 · us-east-1b" {',
        '      i_0a1b2c: "EC2" { style.font-color: "#f0f6fc" }',
        '    }',
        '  }',
        '}',
        `client -> aws.vpc_0abc.subnet_1a2b.alb_web: "1 || HTTPS request" ${STYLE}`
    ].join('\n');
    const out = wrapBoxLabels(src).split('\n');
    assert.match(out[2], /"SUBNET · 10\.0\.1\.0\/24\\nus-east-1a"/);
    assert.match(out[5], /"SUBNET · 10\.0\.2\.0\/24\\nus-east-1b"/);
    // The short VPC title, the service labels, the icon path and the edge label are untouched.
    assert.equal(out[1], '  vpc_0abc: "VPC · 10.0.0.0/16" {');
    assert.equal(out[3], '      alb_web: "ALB" { shape: image; icon: "/aws-icons/networking/elb.svg" }');
    assert.equal(out[10], `client -> aws.vpc_0abc.subnet_1a2b.alb_web: "1 || HTTPS request" ${STYLE}`);
});

// --- renumberSteps with MULTI-AZ replicas ------------------------------------------------------

// One ALB and one Auto Scaling group, each drawn once per AZ. Six edges, but only four steps:
// the fan-out to both ALBs is one, each ALB reaching its own AZ's ASG is one, both ASGs egressing
// through the single NAT is one, and the shared DynamoDB is the last.
const MULTI_AZ = [
    `client -> aws.v.pub_a.alb__pub_a: "1 || Load balance" ${STYLE}`,
    `client -> aws.v.pub_b.alb__pub_b: "2 || Load balance" ${STYLE}`,
    `aws.v.pub_a.alb__pub_a -> aws.v.priv_a.asg__priv_a: "3 || Forward" ${STYLE}`,
    `aws.v.pub_b.alb__pub_b -> aws.v.priv_b.asg__priv_b: "4 || Forward" ${STYLE}`,
    `aws.v.priv_a.asg__priv_a -> aws.v.nat_1: "5 || Egress" ${STYLE}`,
    `aws.v.priv_b.asg__priv_b -> aws.v.nat_1: "6 || Egress" ${STYLE}`
].join('\n');

function stepsOf(text) {
    const out = [];
    mapEdgeLabels(text, (parts) => { out.push(parts[0]); return parts.join(' || '); });
    return out;
}

test('renumberSteps gives the fan-out to two replicas a SINGLE shared number', () => {
    const steps = stepsOf(renumberSteps(MULTI_AZ));
    assert.equal(steps[0], '1');
    assert.equal(steps[1], '1', 'both arrows into the ALB copies are one load-balancing step');
});

test('renumberSteps keeps mirrored branches on the same step, and does not open a sub-level', () => {
    const steps = stepsOf(renumberSteps(MULTI_AZ));
    assert.deepEqual(steps, ['1', '1', '2', '2', '3', '3']);
    assert.ok(!steps.some((s) => s.includes('.')), 'two AZs are one flow mirrored, not a real split');
});

test('renumberSteps leaves a diagram without replicas numbered exactly as before', () => {
    const flat = [
        `client -> aws.alb: "1 || Request" ${STYLE}`,
        `aws.alb -> aws.fn: "2 || Forward" ${STYLE}`,
        `aws.fn -> aws.db: "3 || Query" ${STYLE}`
    ].join('\n');
    assert.equal(renumberSteps(flat), flat);
});

// --- backward edges (declared reversed so a subnet keeps its column) ---------------------------

test('a back edge is numbered by its TRUE direction, same as if written the honest way', () => {
    const honest = [
        `client -> aws.v.pub.alb: "1 || Request" ${STYLE}`,
        `aws.v.pub.alb -> aws.v.priv.asg: "2 || Forward" ${STYLE}`,
        `aws.v.priv.asg -> aws.v.pub.nat: "3 || Egress" ${STYLE}`,
        `aws.v.pub.nat -> aws.v.igw: "4 || Out" ${STYLE}`
    ].join('\n');
    // Same flow, but the egress hop declared backwards and marked.
    const reversed = [
        `client -> aws.v.pub.alb: "1 || Request" ${STYLE}`,
        `aws.v.pub.alb -> aws.v.priv.asg: "2 || Forward" ${STYLE}`,
        `aws.v.pub.nat -> aws.v.priv.asg: "3 || Egress || back" ${STYLE}`,
        `aws.v.pub.nat -> aws.v.igw: "4 || Out" ${STYLE}`
    ].join('\n');
    const steps = (t) => { const o = []; mapEdgeLabels(renumberSteps(t), (p) => { o.push(p[0]); return p.join(' || '); }); return o; };
    assert.deepEqual(steps(honest), ['1', '2', '3', '4']);
    assert.deepEqual(steps(reversed), ['1', '2', '3', '4'], 'the marker restores the real direction');
});

test('the back marker never reaches the rendered label', () => {
    const src = `aws.v.pub.nat -> aws.v.priv.asg: "3 || Egress to internet || back" ${STYLE}`;
    const shown = composeLabel(src, { steps: true });
    assert.match(shown, /"3\. Egress to internet"/);
    assert.ok(!shown.includes('back'), 'the third segment is a marker, never text on the canvas');
});

test('a back edge without the marker is still read the way it is written', () => {
    const src = `aws.v.pub.nat -> aws.v.priv.asg: "1 || Egress" ${STYLE}\naws.v.priv.asg -> aws.v.db: "2 || Query" ${STYLE}`;
    const out = renumberSteps(src);
    const steps = []; mapEdgeLabels(out, (p) => { steps.push(p[0]); return p.join(' || '); });
    assert.deepEqual(steps, ['1', '2']);
});

// --- nudgeCollidingLabels ---------------------------------------------------------------------

// Minimal stand-ins for a compiled diagram: a connection carries its own label metrics (that is what
// applyLabels leaves behind) and a horizontal 2-point route.
const conn = (y, x0, x1, label, w = 100, h = 26) => ({
    src: 'a', dst: 'b', label, labelWidth: w, labelHeight: h,
    route: [{ x: x0, y }, { x: x1, y }]
});
const shape = (id, x, y, w = 60, h = 60) => ({ id, pos: { x, y }, width: w, height: h });
const placed = (d) => d.connections.map((c) => c.labelPosition);

test('nudge: on a clash the LONGER route gives way, moving AWAY from the other label', () => {
    // Boxes are 38px tall (26 + 2x6 margin) and these centres are 23px apart, so they overlap by
    // 15px. The short label sits below, so the long one has to go up to clear it.
    const long = conn(100, 0, 600, 'largo');
    const short = conn(123, 200, 400, 'corto');
    const d = { shapes: [], connections: [long, short] };
    nudgeCollidingLabels(d);
    assert.equal(short.labelPosition, 'INSIDE_MIDDLE_CENTER', 'the short wire keeps the wire');
    assert.equal(long.labelPosition, 'OUTSIDE_TOP_CENTER');
});

test('nudge: with the other label above it, the long one drops instead', () => {
    const short = conn(70, 200, 400, 'corto');
    const long = conn(100, 0, 600, 'largo');
    const d = { shapes: [], connections: [long, short] };
    nudgeCollidingLabels(d);
    assert.equal(long.labelPosition, 'OUTSIDE_BOTTOM_CENTER');
    assert.equal(short.labelPosition, 'INSIDE_MIDDLE_CENTER');
});

test('nudge: when neither side works for the long one, the SHORT one moves instead', () => {
    const short = conn(70, 200, 400, 'corto');
    const long = conn(100, 0, 600, 'largo');
    // A service icon under the long label blocks its way down; going up would land on the short
    // label. With both sides gone, the short one is pushed clear instead.
    const d = { shapes: [shape('svc', 270, 100, 60, 60)], connections: [long, short] };
    nudgeCollidingLabels(d);
    assert.equal(long.labelPosition, 'INSIDE_MIDDLE_CENTER');
    assert.equal(short.labelPosition, 'OUTSIDE_TOP_CENTER', 'the other one gives way instead');
});

test('nudge: a lone label with nothing in its way is left on the wire', () => {
    const only = conn(100, 0, 600, 'solo');
    const far = conn(900, 0, 600, 'lejos');
    const d = { shapes: [], connections: [only, far] };
    nudgeCollidingLabels(d);
    assert.deepEqual(placed(d), ['INSIDE_MIDDLE_CENTER', 'INSIDE_MIDDLE_CENTER']);
});

test('nudge: a label on a VERTICAL run is lifted too — what matters is separating the two labels', () => {
    // The long wire here runs vertically. Lifting slides its label ALONG that wire rather than off
    // it, but that is still what pulls the two labels apart, and the opaque pill keeps it readable.
    const vertical = { src: 'a', dst: 'b', label: 'v', labelWidth: 100, labelHeight: 26,
        route: [{ x: 300, y: 0 }, { x: 300, y: 600 }] };
    const crossing = conn(323, 250, 350, 'h');
    const d = { shapes: [], connections: [vertical, crossing] };
    nudgeCollidingLabels(d);
    assert.equal(vertical.labelPosition, 'OUTSIDE_TOP_CENTER');
    assert.equal(crossing.labelPosition, 'INSIDE_MIDDLE_CENTER');
});

test('nudge: it is deterministic — the same diagram resolves the same way twice', () => {
    const build = () => ({ shapes: [], connections: [conn(100, 0, 600, 'a'), conn(123, 200, 400, 'b')] });
    const one = build(); nudgeCollidingLabels(one);
    const two = build(); nudgeCollidingLabels(two);
    assert.deepEqual(placed(one), placed(two));
});

test('nudge: when no side is free it SLIDES the label along its own wire and reports the offset', () => {
    // Two labels almost exactly on top of each other (centres 4px apart, boxes 38px tall). Lifting
    // moves a label about half its own height, which cannot separate these — sliding can.
    const long = { src: 'a', dst: 'b', id: '(a -> b)[0]', label: 'largo', labelWidth: 100, labelHeight: 26,
        route: [{ x: 0, y: 100 }, { x: 800, y: 100 }] };
    const short = { src: 'c', dst: 'd', id: '(c -> d)[0]', label: 'corto', labelWidth: 100, labelHeight: 26,
        route: [{ x: 350, y: 104 }, { x: 450, y: 104 }] };
    const d = { shapes: [], connections: [long, short] };
    const slides = nudgeCollidingLabels(d);
    assert.equal(slides.size, 1, 'exactly one label had to move');
    const [id, off] = [...slides][0];
    assert.equal(id, '(a -> b)[0]', 'the long wire is the one that gives way');
    assert.ok(Math.abs(off.dx) > 50, `slid a useful distance along the wire, got ${off.dx}`);
    assert.equal(off.dy, 0, 'a horizontal wire slides horizontally');
});

test('nudge: with nothing overlapping, nothing slides', () => {
    const a = { src: 'a', dst: 'b', id: '(a -> b)[0]', label: 'a', labelWidth: 100, labelHeight: 26,
        route: [{ x: 0, y: 100 }, { x: 600, y: 100 }] };
    const b = { src: 'c', dst: 'd', id: '(c -> d)[0]', label: 'b', labelWidth: 100, labelHeight: 26,
        route: [{ x: 0, y: 900 }, { x: 600, y: 900 }] };
    assert.equal(nudgeCollidingLabels({ shapes: [], connections: [a, b] }).size, 0);
});

test('applyLabelSlides moves the pill and text, drops the stale gap, and leaves other edges alone', () => {
    const cls = Buffer.from('(a -&gt; b)[0]', 'utf8').toString('base64');
    const other = Buffer.from('(c -&gt; d)[0]', 'utf8').toString('base64');
    const svg =
        `<g class="${cls}"><path d="M0 0" mask="url(#m1)" /><rect x="1" y="2" /><text x="3" y="4">hola</text></g>` +
        `<g class="${other}"><path d="M0 0" mask="url(#m2)" /><rect x="9" y="9" /><text x="9" y="9">otra</text></g>`;
    const out = applyLabelSlides(svg, new Map([['(a -> b)[0]', { dx: -40, dy: 0 }]]));
    assert.match(out, /<rect transform="translate\(-40\.00,0\.00\)" x="1"/);
    assert.match(out, /<text transform="translate\(-40\.00,0\.00\)" x="3"/);
    assert.ok(!/mask="url\(#m1\)"/.test(out), 'the gap where the label used to sit is removed');
    assert.match(out, /mask="url\(#m2\)"/, 'the untouched edge keeps its own gap');
    assert.ok(!/<rect transform[^>]*x="9"/.test(out), 'the untouched edge is not moved');
});

test('applyLabelSlides with nothing to move returns the SVG untouched', () => {
    const svg = '<g class="YWJj"><text x="1" y="2">x</text></g>';
    assert.equal(applyLabelSlides(svg, new Map()), svg);
});

test('nudge: a connection with a degenerate route is skipped, not crashed on', () => {
    // D2 can return a label with a route of one point, or none at all. Its box is null, and comparing
    // against null used to throw — which cost the whole diagram, because the caller turns any throw
    // in this pass into a render error for the user.
    const good = { src: 'a', dst: 'b', id: '(a -> b)[0]', label: 'ok', labelWidth: 100, labelHeight: 26,
        route: [{ x: 0, y: 100 }, { x: 600, y: 100 }] };
    for (const route of [[{ x: 300, y: 100 }], undefined, null]) {
        const bad = { src: 'c', dst: 'd', id: '(c -> d)[0]', label: 'malo', labelWidth: 100, labelHeight: 26, route };
        assert.doesNotThrow(() => nudgeCollidingLabels({ shapes: [], connections: [good, bad] }));
    }
});

// --- spreadCrowdedAttachments -------------------------------------------------------------------
// A hub node whose edges all leave the same side, which is what ELK produces on a `direction: right`
// diagram and what turns a well-connected service into a comb of parallel lines.
const HUB = () => ({ id: 'hub', pos: { x: 500, y: 300 }, width: 100, height: 100 });
// One edge leaving the hub's RIGHT side (x = 500+100) toward a partner far to the right at `farY`.
const spoke = (farY, y) => ({ src: 'hub', dst: `t${farY}`, route: [{ x: 600, y }, { x: 1200, y: farY }] });
const sideCounts = (d) => {
    const hub = d.shapes[0];
    const counts = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const c of d.connections) {
        const p = c.route[0];
        if (Math.abs(p.x - 600) <= 0.5) counts.right++;
        else if (Math.abs(p.y - 300) <= 0.5) counts.top++;
        else if (Math.abs(p.y - 400) <= 0.5) counts.bottom++;
        else if (Math.abs(p.x - 500) <= 0.5) counts.left++;
    }
    return counts;
};

test('spread: six edges on one side are cut back to the cap, using top and bottom', () => {
    const conns = [spoke(50, 310), spoke(100, 330), spoke(150, 350),
                   spoke(700, 360), spoke(750, 380), spoke(800, 395)];
    const d = { shapes: [HUB()], connections: conns };
    spreadCrowdedAttachments(d);
    const n = sideCounts(d);
    assert.equal(n.right, 3, 'the crowded side is back under the cap');
    assert.equal(n.top + n.bottom, 3, 'the overflow went to the perpendicular sides');
    assert.ok(n.top > 0 && n.bottom > 0, 'and it was split between them, not piled on one');
});

test('spread: a side at the cap is left completely alone', () => {
    const d = { shapes: [HUB()], connections: [spoke(50, 310), spoke(700, 350), spoke(800, 390)] };
    const before = structuredClone(d);
    spreadCrowdedAttachments(d);
    assert.deepEqual(d, before, 'three on a side still reads fine — nothing to fix');
});

test('spread: the partner furthest out gets the outermost slot, so the legs cannot cross', () => {
    const conns = [spoke(50, 310), spoke(100, 330), spoke(150, 350),
                   spoke(700, 360), spoke(750, 380), spoke(800, 395)];
    const d = { shapes: [HUB()], connections: conns };
    spreadCrowdedAttachments(d);
    const onTop = conns.filter((c) => Math.abs(c.route[0].y - 300) <= 0.5)
        .sort((a, b) => a.route[0].x - b.route[0].x);
    const partnerY = onTop.map((c) => c.route[c.route.length - 1].y);
    assert.deepEqual(partnerY, [...partnerY].sort((a, b) => a - b),
        'left-to-right along the top edge = highest partner first');
});

test('spread: a spilled edge is rebuilt as a purely orthogonal path', () => {
    const conns = [spoke(50, 310), spoke(100, 330), spoke(150, 350),
                   spoke(700, 360), spoke(750, 380), spoke(800, 395)];
    // Give one a bend, as ELK would: it is replaced, since it was routed for a sideways departure.
    conns[0].route = [{ x: 600, y: 310 }, { x: 900, y: 310 }, { x: 900, y: 50 }, { x: 1200, y: 50 }];
    const d = { shapes: [HUB()], connections: conns };
    spreadCrowdedAttachments(d);
    // Only the rebuilt ones: an untouched route is still the 2-point stub this fixture starts with,
    // which orthogonalizeConnectionRoutes squares off later in the real pipeline.
    const rebuilt = conns.filter((c) => Math.abs(c.route[0].x - 600) > 0.5);
    assert.ok(rebuilt.length, 'something did spill');
    for (const c of rebuilt) {
        for (let i = 1; i < c.route.length; i++) {
            const a = c.route[i - 1], b = c.route[i];
            assert.ok(Math.abs(a.x - b.x) <= 0.5 || Math.abs(a.y - b.y) <= 0.5,
                'every leg is horizontal or vertical, never diagonal');
        }
    }
});

test('spread: when every lane out is blocked, the arrow stays put rather than cross an icon', () => {
    // Four on the right; the only spill candidates head UP, and a wall seals every lane above the
    // node — the direct run and all the corridors. Nothing may move.
    const conns = [spoke(50, 310), spoke(60, 330), spoke(70, 350), spoke(350, 370)];
    const wall = { id: 'wall', pos: { x: 400, y: 120 }, width: 900, height: 179 };
    const d = { shapes: [HUB(), wall], connections: conns };
    spreadCrowdedAttachments(d);
    assert.equal(sideCounts(d).right, 4, 'better crowded than drawn through a node');
});

// --- shrinkPortInflatedNodes ---------------------------------------------------------------------
test('shrink: a node ELK grew to fit its ports goes back to square, keeping its centre', () => {
    // 128 wide, 240 tall: what ELK returns for a node with six edges on one side.
    const node = { id: 'hub', pos: { x: 500, y: 300 }, width: 128, height: 240 };
    const conns = [-100, -60, -20, 20, 60, 100].map((dy) => ({
        src: 'hub', dst: 'far', route: [{ x: 628, y: 420 + dy }, { x: 1200, y: 420 + dy }] }));
    const d = { shapes: [node], connections: conns };
    shrinkPortInflatedNodes(d);
    assert.equal(node.height, 128, 'squared off');
    assert.equal(node.pos.y + node.height / 2, 420, 'and the icon has not moved');
    for (const c of conns) {
        assert.ok(c.route[0].y >= node.pos.y && c.route[0].y <= node.pos.y + node.height,
            'every endpoint is back on the smaller box');
    }
});

test('shrink: a box wider than tall is never touched — that is a real labelled node', () => {
    const wide = { id: 'plain', pos: { x: 500, y: 300 }, width: 240, height: 100 };
    const conns = [0, 20, 40, 60].map((dy) => ({
        src: 'plain', dst: 'far', route: [{ x: 740, y: 320 + dy }, { x: 1200, y: 320 + dy }] }));
    const d = { shapes: [wide], connections: conns };
    const before = structuredClone(d);
    shrinkPortInflatedNodes(d);
    assert.deepEqual(d, before);
});

test('shrink: a square node at the cap is left alone', () => {
    const node = { id: 'hub', pos: { x: 500, y: 300 }, width: 128, height: 128 };
    const d = { shapes: [node], connections: [{ src: 'hub', dst: 'far', route: [{ x: 628, y: 364 }, { x: 1200, y: 364 }] }] };
    const before = structuredClone(d);
    shrinkPortInflatedNodes(d);
    assert.deepEqual(d, before);
});

test('spread: a blocked straight run falls back to a clear corridor instead of giving up', () => {
    // The direct L from the top edge up to the partner would cut straight through `wall`; a lane
    // closer to the node clears it, so the arrow still gets to leave the crowded side.
    const conns = [spoke(50, 310), spoke(100, 330), spoke(150, 350),
                   spoke(700, 360), spoke(750, 380), spoke(800, 395)];
    const wall = { id: 'wall', pos: { x: 520, y: 80 }, width: 400, height: 40 };
    const d = { shapes: [HUB(), wall], connections: conns };
    spreadCrowdedAttachments(d);
    assert.ok(sideCounts(d).right <= 3, 'the cap still holds');
    for (const c of conns) {
        for (let i = 1; i < c.route.length; i++) {
            const a = c.route[i - 1], b = c.route[i];
            assert.ok(!(a.x > wall.pos.x && a.x < wall.pos.x + wall.width
                && b.x > wall.pos.x && b.x < wall.pos.x + wall.width
                && Math.min(a.y, b.y) < wall.pos.y + wall.height && Math.max(a.y, b.y) > wall.pos.y),
                'and no leg runs through the icon');
        }
    }
});

test('spread: two arrows off the same side never share a lane, so neither hides the other', () => {
    const conns = [spoke(50, 310), spoke(100, 330), spoke(150, 350),
                   spoke(700, 360), spoke(750, 380), spoke(800, 395)];
    const d = { shapes: [HUB()], connections: conns };
    spreadCrowdedAttachments(d);
    for (const side of [-1, 1]) {
        const edgeY = side < 0 ? 300 : 400;
        const lanes = conns
            .filter((c) => Math.abs(c.route[0].y - edgeY) <= 0.5 && c.route.length > 2)
            .map((c) => c.route[1].y);
        assert.equal(new Set(lanes).size, lanes.length, 'every arrow crosses at its own height');
    }
});

test('spread: an arrow meets its partner head-on instead of sliding down its border', () => {
    const sink = { id: 'sink', pos: { x: 1200, y: 40 }, width: 128, height: 128 };
    // The partner's endpoint sits on the sink's LEFT face, so the last leg has to be horizontal.
    const up = { src: 'hub', dst: 'sink', route: [{ x: 600, y: 310 }, { x: 1200, y: 104 }] };
    const conns = [up, spoke(360, 330), spoke(370, 350), spoke(380, 370)];
    // A wall forces the corridor shape rather than the plain L, which is where the bug lived.
    const wall = { id: 'wall', pos: { x: 560, y: 150 }, width: 90, height: 100 };
    const d = { shapes: [HUB(), sink, wall], connections: conns };
    spreadCrowdedAttachments(d);
    assert.ok(up.route.length > 2, 'it spilled');
    const last = up.route[up.route.length - 1], prev = up.route[up.route.length - 2];
    assert.ok(Math.abs(last.y - prev.y) <= 0.5, 'the final leg runs level into the partner');
});

test('spread: arrows to partners in one column never share a descent, so none hides another', () => {
    // Three partners stacked in the SAME column: the earlier version turned in at a fixed distance,
    // so all three descents fell on one x and drew over each other (measured on a real diagram:
    // three vertical pairs 0px apart, overlapping for up to 305px).
    const column = [40, 200, 620].map((y, i) => ({ id: 'sink' + i, pos: { x: 1200, y }, width: 128, height: 128 }));
    const conns = column.map((s, i) => ({ src: 'hub', dst: s.id,
        route: [{ x: 600, y: 320 + i * 20 }, { x: 1200, y: s.pos.y + 64 }] }));
    conns.push(spoke(345, 380), spoke(355, 390));
    const d = { shapes: [HUB(), ...column], connections: conns };
    spreadCrowdedAttachments(d);

    const runs = [];
    for (const c of conns) {
        for (let i = 1; i < c.route.length; i++) {
            const a = c.route[i - 1], b = c.route[i];
            if (Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) >= 40) {
                runs.push({ c, x: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
            }
        }
    }
    for (let i = 0; i < runs.length; i++) {
        for (let k = i + 1; k < runs.length; k++) {
            const A = runs[i], B = runs[k];
            if (A.c === B.c) continue;
            const overlap = Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo);
            assert.ok(Math.abs(A.x - B.x) > 20 || overlap < 60,
                `two descents at x=${A.x} and x=${B.x} run together for ${overlap}px`);
        }
    }
});

// --- two-headed arrows ---------------------------------------------------------------------------
const BOTH = [
    'direction: right',
    '',
    'aws.fn -> aws.ecr: "1 || Pull image || both" ' + STYLE,
    'aws.fn -> aws.ses: "2 || Send verification email" ' + STYLE,
].join('\n');

test('both: the marker never reaches the canvas, in either view', () => {
    for (const steps of [false, true]) {
        const out = composeLabel(BOTH, { steps });
        assert.ok(!/both/.test(out), `the marker leaked into the ${steps ? 'step' : 'action'} view`);
        assert.match(out, /Pull image/);
    }
});

test('both: a marked edge is numbered exactly like an unmarked one', () => {
    const plain = BOTH.replace(' || both', '');
    assert.deepEqual(steps(renumberSteps(BOTH)), steps(renumberSteps(plain)));
});

test('both: isBothEndsLabel only fires on the third segment, and never alongside back', () => {
    assert.equal(isBothEndsLabel(['1', 'Pull image', 'both']), true);
    assert.equal(isBothEndsLabel(['1', 'Pull image']), false, 'a two-segment label is one-way');
    assert.equal(isBothEndsLabel(['1', 'Egress to internet', 'back']), false);
    // An edge that somehow carries both markers is an egress first: one-way, and reversed.
    assert.equal(isBothEndsLabel(['1', 'Egress', 'back', 'both']), false);
    assert.equal(isBackEdgeLabel(['1', 'Egress', 'back', 'both']), true);
});
