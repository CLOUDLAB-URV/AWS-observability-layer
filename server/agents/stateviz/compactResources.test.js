'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactResources, looksComplete } from './index.js';

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

test('compactResources keeps an attachment identity + purpose but drops its details', () => {
    const [entry] = compactResources([
        {
            id: 'fn',
            type: 'lambda',
            attachments: [{
                type: 'iam-role',
                id: 'checkout-fn-role',
                name: 'checkout-fn-role',
                purpose: 'Lets the function read the orders table.',
                arn: 'arn:aws:iam::1:role/checkout-fn-role',
                details: { AssumeRolePolicyDocument: 'SECRETPOLICYBLOB', Policies: ['AWSLambdaBasicExecutionRole'] }
            }]
        }
    ]);
    assert.deepEqual(entry.attachments, [{
        type: 'iam-role',
        id: 'checkout-fn-role',
        name: 'checkout-fn-role',
        purpose: 'Lets the function read the orders table.'
    }]);
    // The bulky policy documents must never reach a prompt.
    assert.ok(!JSON.stringify(entry).includes('SECRETPOLICYBLOB'), 'attachment details leaked');
});

test('compactResources leaves resources without attachments untouched (no attachments key added)', () => {
    const [entry] = compactResources([{ id: 's3', type: 's3', name: 'bucket' }]);
    assert.equal('attachments' in entry, false);
});

test('looksComplete rejects the shapes a cut-off generation leaves behind', () => {
    // The real failure seen in production: the answer stopped mid-declaration, leaving unbalanced
    // braces and a key with no value. Persisting that broke the sigil's render permanently.
    assert.equal(looksComplete('aws: "AWS" {\n  vpc: "VPC" {\n    node: "x"\n'), false, 'unbalanced braces');
    assert.equal(looksComplete('aws: "AWS" {\n  node:\n'), false, 'a key whose value never arrived');
    assert.equal(looksComplete('aws: "AWS" {\n  node: "x"\n}\n} \n'), false, 'one brace too many');
    assert.equal(looksComplete(''), false);
    assert.equal(looksComplete(null), false);
});

test('looksComplete accepts well-formed D2, braces inside labels included', () => {
    assert.equal(looksComplete('direction: right\naws: "AWS" {\n  node: "x"\n}\n'), true);
    assert.equal(looksComplete('a: "un { raro" {\n  b: "y otro }"\n}\n'), true, 'braces in quotes do not count');
    assert.equal(looksComplete('a -> b: "1 || Query"\n'), true, 'a flat diagram with no maps at all');
});
