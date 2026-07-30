'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renumberSteps, mapEdgeLabels, wrapLabel } from './diagram.js';

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
