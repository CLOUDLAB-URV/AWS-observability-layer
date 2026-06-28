'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './authStore.js';

// These are pure (no file IO), so they're safe to unit-test without touching persistence/.

test('password hash round-trips and is salted', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.match(hash, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(verifyPassword('correct horse battery staple', hash), true);

    // Same password hashed twice → different output (random salt).
    const hash2 = hashPassword('correct horse battery staple');
    assert.notEqual(hash, hash2);
    assert.equal(verifyPassword('correct horse battery staple', hash2), true);
});

test('wrong password and malformed hashes are rejected', () => {
    const hash = hashPassword('s3cret-password');
    assert.equal(verifyPassword('wrong', hash), false);
    assert.equal(verifyPassword('s3cret-password', 'not-a-hash'), false);
    assert.equal(verifyPassword('s3cret-password', 'bcrypt$x$y'), false);
    assert.equal(verifyPassword('s3cret-password', ''), false);
});
