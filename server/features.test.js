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

test('unset flags default to enabled (bare container = full app)', () => {
    delete process.env.AGENT_ENABLED;
    delete process.env.DESIGN_ENABLED;
    assert.equal(features.agent, true);
    assert.equal(features.design, true);
});

test('a mode is disabled only when explicitly turned off', () => {
    process.env.DESIGN_ENABLED = 'false';
    delete process.env.AGENT_ENABLED;
    assert.equal(features.design, false);
    assert.equal(features.agent, true);
});

test('flag parser: 1/true/yes/on enable; false/0/no/off/empty(=unset)→default disable', () => {
    for (const v of ['1', 'true', 'YES', 'On']) {
        process.env.DESIGN_ENABLED = v;
        assert.equal(features.design, true, `expected ${v} → enabled`);
    }
    for (const v of ['0', 'false', 'no', 'OFF', 'maybe']) {
        process.env.DESIGN_ENABLED = v;
        assert.equal(features.design, false, `expected ${v} → disabled`);
    }
});
