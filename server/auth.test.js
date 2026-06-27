'use strict';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { authEnabled, _internal } from './auth.js';

const { sign, unsign } = _internal;
const ORIGINAL = { ...process.env };
afterEach(() => {
    process.env = { ...ORIGINAL };
});

test('authEnabled is true only when both Google creds are set', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.equal(authEnabled(), false);

    process.env.GOOGLE_CLIENT_ID = 'id';
    assert.equal(authEnabled(), false, 'id alone is not enough');

    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    assert.equal(authEnabled(), true);
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
