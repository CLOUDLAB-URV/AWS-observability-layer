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

test('unset flag defaults to enabled (bare container = full app)', () => {
    delete process.env.AGENT_ENABLED;
    assert.equal(features.agent, true);
});

test('the mode is disabled only when explicitly turned off', () => {
    process.env.AGENT_ENABLED = 'false';
    assert.equal(features.agent, false);
});

test('flag parser: 1/true/yes/on enable; false/0/no/off/empty(=unset)→default disable', () => {
    for (const v of ['1', 'true', 'YES', 'On']) {
        process.env.AGENT_ENABLED = v;
        assert.equal(features.agent, true, `expected ${v} → enabled`);
    }
    for (const v of ['0', 'false', 'no', 'OFF', 'maybe']) {
        process.env.AGENT_ENABLED = v;
        assert.equal(features.agent, false, `expected ${v} → disabled`);
    }
});
