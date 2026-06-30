'use strict';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authEnabled, _internal } from './auth.js';
import { DEV } from './persistence.js';

const { sign, unsign } = _internal;
const ORIGINAL = { ...process.env };
afterEach(() => {
    process.env = { ...ORIGINAL };
});

test('authEnabled defaults to prod-on / dev-off, and AUTH_DISABLED overrides either way', () => {
    // DEV is fixed at import (NODE_ENV at load): off in local dev, on in production.
    delete process.env.AUTH_DISABLED;
    assert.equal(authEnabled(), !DEV);

    // Explicit override beats the default in both directions.
    process.env.AUTH_DISABLED = 'true';
    assert.equal(authEnabled(), false);

    process.env.AUTH_DISABLED = 'false';
    assert.equal(authEnabled(), true, 'false means auth stays on, even in dev');
});

test('signed value round-trips and rejects tampering', () => {
    process.env.SESSION_SECRET = 'test-secret';
    const signed = sign('sid-abc');
    assert.equal(unsign(signed), 'sid-abc');

    // Tampered payload → rejected.
    assert.equal(unsign(`sid-xyz${signed.slice(signed.lastIndexOf('.'))}`), null);
    // Garbage / no signature → rejected.
    assert.equal(unsign('no-dot'), null);
    assert.equal(unsign(''), null);
});

test('a value signed with a different secret does not verify', () => {
    process.env.SESSION_SECRET = 'secret-a';
    const signed = sign('sid-1');
    process.env.SESSION_SECRET = 'secret-b';
    assert.equal(unsign(signed), null);
});
