'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChanges, MAX_CODE_CHARS, MAX_CODE_FILES, MAX_PURPOSE_CHARS } from './normalizeChanges.js';

const base = { op: 'upsert', type: 'lambda', id: 'fn-1' };
const one = (code) => normalizeChanges({ changes: [{ ...base, code }] })[0];

test('code: a well-formed file is kept with name, language and content', () => {
    const res = one([{ name: 'handler.py', language: 'python', content: 'print(1)' }]);
    assert.deepEqual(res.code, [{ name: 'handler.py', content: 'print(1)', language: 'python' }]);
});

test('code: per-file content is capped to MAX_CODE_CHARS', () => {
    const big = 'x'.repeat(MAX_CODE_CHARS + 5000);
    const res = one([{ name: 'big.js', content: big }]);
    assert.equal(res.code[0].content.length, MAX_CODE_CHARS);
});

test('code: the number of files is capped to MAX_CODE_FILES', () => {
    const many = Array.from({ length: MAX_CODE_FILES + 8 }, (_, i) => ({
        name: `f${i}.txt`,
        content: `body ${i}`
    }));
    const res = one(many);
    assert.equal(res.code.length, MAX_CODE_FILES);
    assert.equal(res.code[0].name, 'f0.txt', 'keeps the first files in order');
});

test('code: entries with an empty name or empty content are dropped', () => {
    const res = one([
        { name: '', content: 'orphan' },
        { name: 'empty.py', content: '' },
        { name: 'ok.py', content: 'pass' }
    ]);
    assert.deepEqual(res.code, [{ name: 'ok.py', content: 'pass' }]);
});

test('code: an absent language key is omitted (not stored as empty)', () => {
    const res = one([{ name: 'a.sh', content: 'echo hi' }]);
    assert.equal('language' in res.code[0], false);
});

test('code: a non-array (or all-invalid) code field drops the key entirely', () => {
    assert.equal('code' in one('not-an-array'), false);
    assert.equal('code' in one([{ name: '', content: '' }]), false);
    assert.equal('code' in one(undefined), false);
});

const purposed = (purpose) => normalizeChanges({ changes: [{ ...base, purpose }] })[0];

test('purpose: a plain sentence is kept, trimmed', () => {
    assert.equal(purposed('  Writes the order to DynamoDB.  ').purpose, 'Writes the order to DynamoDB.');
});

test('purpose: newlines collapse to a single line', () => {
    assert.equal(purposed('Validates the payload\n\nand stores it.').purpose, 'Validates the payload and stores it.');
});

test('purpose: it is capped to MAX_PURPOSE_CHARS', () => {
    assert.equal(purposed('x'.repeat(MAX_PURPOSE_CHARS + 200)).purpose.length, MAX_PURPOSE_CHARS);
});

test('purpose: empty, blank or non-string values drop the key entirely', () => {
    assert.equal('purpose' in purposed(''), false);
    assert.equal('purpose' in purposed('   '), false);
    assert.equal('purpose' in purposed(42), false);
    assert.equal('purpose' in purposed(undefined), false);
});

// --- scope (public/private subnets) ---------------------------------------------------------

const subnet = (extra) => normalizeChanges({ changes: [{ op: 'upsert', type: 'subnet', id: 'subnet-1', ...extra }] })[0];

test('scope: the two known words are kept, lowercased and trimmed', () => {
    assert.equal(subnet({ scope: 'public' }).scope, 'public');
    assert.equal(subnet({ scope: '  PRIVATE ' }).scope, 'private');
});

test('scope: anything that is not public/private drops the key', () => {
    assert.equal('scope' in subnet({ scope: 'isolated' }), false);
    assert.equal('scope' in subnet({ scope: '' }), false);
    assert.equal('scope' in subnet({ scope: true }), false);
    assert.equal('scope' in subnet({}), false);
});

test('scope: it is derived from MapPublicIpOnLaunch when the agent omits it', () => {
    assert.equal(subnet({ details: { MapPublicIpOnLaunch: true } }).scope, 'public');
    assert.equal('scope' in subnet({ details: { MapPublicIpOnLaunch: false } }), false);
});

test('scope: an explicit value beats the derived one', () => {
    assert.equal(subnet({ scope: 'private', details: { MapPublicIpOnLaunch: true } }).scope, 'private');
});

test('scope: MapPublicIpOnLaunch is only read on subnets', () => {
    const ec2 = normalizeChanges({
        changes: [{ op: 'upsert', type: 'ec2', id: 'i-1', details: { MapPublicIpOnLaunch: true } }]
    })[0];
    assert.equal('scope' in ec2, false);
});

// --- vpc / subnet containment ---------------------------------------------------------------

const placed = (extra) => normalizeChanges({ changes: [{ ...base, ...extra }] })[0];

test('containment: vpc and subnet are kept trimmed', () => {
    const res = placed({ vpc: ' vpc-0abc ', subnet: 'subnet-1a2b' });
    assert.equal(res.vpc, 'vpc-0abc');
    assert.equal(res.subnet, 'subnet-1a2b');
});

test('containment: an empty string SURVIVES as the explicit "take it out" sentinel', () => {
    const res = placed({ vpc: '', subnet: '   ' });
    assert.equal(res.vpc, '');
    assert.equal(res.subnet, '', 'a blank string trims down to the same sentinel');
});

test('containment: a missing or non-string value drops the key, meaning "unchanged"', () => {
    assert.equal('vpc' in placed({}), false);
    assert.equal('vpc' in placed({ vpc: null }), false);
    assert.equal('subnet' in placed({ subnet: 7 }), false);
});
