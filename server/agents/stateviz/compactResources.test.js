'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactResources } from './index.js';

test('compactResources replaces code bodies with a {name, language, bytes} summary', () => {
    const content = 'def handler(event, ctx):\n    return 200\n';
    const [entry] = compactResources([
        { id: 'fn', type: 'lambda', code: [{ name: 'handler.py', language: 'python', content }] }
    ]);
    assert.deepEqual(entry.code, [{ name: 'handler.py', language: 'python', bytes: content.length }]);
    // The raw source must never reach the model prompt.
    assert.ok(!JSON.stringify(entry).includes('def handler'), 'code content leaked into the compact entry');
});

test('compactResources leaves resources without code untouched (no code key added)', () => {
    const [entry] = compactResources([{ id: 's3', type: 's3', name: 'bucket' }]);
    assert.equal('code' in entry, false);
});
