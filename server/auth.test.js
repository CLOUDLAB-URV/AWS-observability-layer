'use strict';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authEnabled, _internal } from './auth.js';

const { sign, unsign } = _internal;
const ORIGINAL = { ...process.env };
afterEach(() => {
    process.env = { ...ORIGINAL };
});

test('authEnabled is on by default and off only when AUTH_DISABLED is truthy', () => {
    delete process.env.AUTH_DISABLED;
    assert.equal(authEnabled(), true);

    process.env.AUTH_DISABLED = 'true';
    assert.equal(authEnabled(), false);

    process.env.AUTH_DISABLED = 'false';
    assert.equal(authEnabled(), true, 'false means auth stays on');
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
