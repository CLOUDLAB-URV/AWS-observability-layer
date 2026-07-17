'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChanges, MAX_CODE_CHARS, MAX_CODE_FILES } from './normalizeChanges.js';

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
