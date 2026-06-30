'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, create, revoke } from './tokenStore.js';
import { DEV, DEV_TOKEN, DEV_USER_ID } from './persistence.js';

// The test runner has no NODE_ENV=production, so DEV is true here: the dev branch of tokenStore
// never touches the filesystem, so these are safe to run without an isolated persistence dir.

test('dev: the fixed env token resolves to the fixed dev user', async () => {
    assert.equal(DEV, true, 'expected the test runner to be in dev mode');

    assert.deepEqual(await verify(DEV_TOKEN), { userId: DEV_USER_ID, label: 'local dev (env)' });
});

test('dev: any other token is rejected, and generation/revocation are disabled', async () => {
    assert.equal(await verify('viz_somethingelse'), null);
    assert.equal(await verify(''), null);

    assert.deepEqual(await create(DEV_USER_ID, 'web'), { error: 'dev_disabled' });
    assert.equal(await revoke(DEV_USER_ID, 'tok_x'), false);
});
