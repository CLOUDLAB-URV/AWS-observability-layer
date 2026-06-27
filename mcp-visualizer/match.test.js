'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, matchByName } from './match.js';

const chats = [
    { chatId: 'c1', name: 'VPC Network Foundation' },
    { chatId: 'c2', name: 'S3 SQS event queue' }
];

test('normalizeName lowercases and collapses non-alphanumerics', () => {
    assert.equal(normalizeName('  S3 / SQS  Event!! '), 's3 sqs event');
    assert.equal(normalizeName(null), '');
});

test('exact (normalized) name wins', () => {
    assert.equal(matchByName('s3 sqs event queue', chats)?.chatId, 'c2');
    assert.equal(matchByName('VPC   network foundation', chats)?.chatId, 'c1');
});

test('partial / distinctive token still matches the right chat', () => {
    assert.equal(matchByName('vpc network', chats)?.chatId, 'c1');
    assert.equal(matchByName('sqs queue', chats)?.chatId, 'c2');
});

test('unrelated query resolves to no match', () => {
    assert.equal(matchByName('lambda api gateway dynamo', chats), null);
});

test('empty query or empty list → null', () => {
    assert.equal(matchByName('', chats), null);
    assert.equal(matchByName('vpc', []), null);
});
