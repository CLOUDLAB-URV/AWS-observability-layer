'use strict';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { features } from './features.js';

// features.js reads process.env lazily (getters), so mutating env here is observed
// without re-importing.
const ORIGINAL = { ...process.env };
afterEach(() => {
    process.env = { ...ORIGINAL };
});

test('development: everything is available regardless of flags', () => {
    process.env.NODE_ENV = 'development';
    process.env.DESIGN_ENABLED = 'false';
    delete process.env.AGENT_ENABLED;
    assert.equal(features.design, true);
    assert.equal(features.agent, true);
});

test('production: a feature is on only when its flag is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.AGENT_ENABLED = 'true';
    delete process.env.DESIGN_ENABLED; // unset → off
    assert.equal(features.agent, true);
    assert.equal(features.design, false);
});

test('production: flag parser accepts 1/true/yes/on and rejects others', () => {
    process.env.NODE_ENV = 'production';
    for (const v of ['1', 'true', 'YES', 'On']) {
        process.env.DESIGN_ENABLED = v;
        assert.equal(features.design, true, `expected ${v} → true`);
    }
    for (const v of ['0', 'false', 'no', '', 'maybe']) {
        process.env.DESIGN_ENABLED = v;
        assert.equal(features.design, false, `expected ${v} → false`);
    }
});
