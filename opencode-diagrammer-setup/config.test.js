'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOpencodeConfig, removeOpencodeConfig, parseArgs, SERVER_KEY, OPENCODE_SCHEMA } from './config.js';

test('creates the full entry (and $schema) from an empty config', () => {
    const out = applyOpencodeConfig({}, { token: 'viz_abc123' });
    assert.equal(out.$schema, OPENCODE_SCHEMA);
    const entry = out.mcp[SERVER_KEY];
    assert.equal(entry.type, 'local');
    assert.deepEqual(entry.command, ['npx', '-y', 'sigilum-mcp@latest']);
    assert.equal(entry.enabled, true);
    assert.equal(entry.environment.SIGILUM_TOKEN, 'viz_abc123');
    assert.equal('SIGILUM_URL' in entry.environment, false);
});

test('includes SIGILUM_URL only when provided, and only on creation', () => {
    const out = applyOpencodeConfig({}, { token: 'viz_abc', url: 'http://127.0.0.1:3001' });
    assert.equal(out.mcp[SERVER_KEY].environment.SIGILUM_URL, 'http://127.0.0.1:3001');
});

test('adds the entry when mcp exists but has other servers, preserving them', () => {
    const config = { $schema: 'x', mcp: { other: { type: 'local', enabled: true } } };
    const out = applyOpencodeConfig(config, { token: 'viz_new' });
    assert.deepEqual(out.mcp.other, { type: 'local', enabled: true }, 'other server untouched');
    assert.equal(out.mcp[SERVER_KEY].environment.SIGILUM_TOKEN, 'viz_new');
    assert.equal(out.$schema, 'x', 'existing $schema not overwritten');
});

test('re-run only updates the token, preserving every other field', () => {
    const config = {
        mcp: {
            [SERVER_KEY]: {
                type: 'local',
                command: ['node', '/custom/path.js'],   // user customised
                enabled: false,                          // user customised
                environment: { SIGILUM_TOKEN: 'viz_old', EXTRA: 'keep-me' },
                customField: 123
            }
        }
    };
    const out = applyOpencodeConfig(config, { token: 'viz_fresh', url: 'http://ignored' });
    const entry = out.mcp[SERVER_KEY];
    assert.equal(entry.environment.SIGILUM_TOKEN, 'viz_fresh', 'token refreshed');
    assert.equal(entry.environment.EXTRA, 'keep-me', 'extra env preserved');
    assert.deepEqual(entry.command, ['node', '/custom/path.js'], 'custom command preserved');
    assert.equal(entry.enabled, false, 'enabled flag preserved');
    assert.equal(entry.customField, 123, 'extra field preserved');
    assert.equal('SIGILUM_URL' in entry.environment, false, 'url not added on re-run');
});

test('creates environment if a malformed entry lacks one', () => {
    const config = { mcp: { [SERVER_KEY]: { type: 'local', enabled: true } } };
    const out = applyOpencodeConfig(config, { token: 'viz_x' });
    assert.equal(out.mcp[SERVER_KEY].environment.SIGILUM_TOKEN, 'viz_x');
});

test('applyOpencodeConfig rejects bad inputs', () => {
    assert.throws(() => applyOpencodeConfig(null, { token: 'viz_x' }), /JSON object/);
    assert.throws(() => applyOpencodeConfig([], { token: 'viz_x' }), /JSON object/);
    assert.throws(() => applyOpencodeConfig({}, {}), /token is required/);
});

test('removeOpencodeConfig removes the entry and cleans up the empty mcp wrapper', () => {
    const config = { $schema: 'x', mcp: { [SERVER_KEY]: { type: 'local', enabled: true } } };
    const removed = removeOpencodeConfig(config);
    assert.equal(removed, true);
    assert.equal('mcp' in config, false, 'empty mcp wrapper cleaned up');
    assert.equal(config.$schema, 'x', 'other fields untouched');
});

test('removeOpencodeConfig preserves other servers under mcp', () => {
    const config = { mcp: { [SERVER_KEY]: { type: 'local' }, other: { type: 'local', enabled: true } } };
    const removed = removeOpencodeConfig(config);
    assert.equal(removed, true);
    assert.equal(SERVER_KEY in config.mcp, false);
    assert.deepEqual(config.mcp.other, { type: 'local', enabled: true });
});

test('removeOpencodeConfig is idempotent: a no-op (returns false) when nothing to remove', () => {
    assert.equal(removeOpencodeConfig({}), false);
    assert.equal(removeOpencodeConfig({ mcp: { other: { type: 'local' } } }), false);
    const config = { mcp: { [SERVER_KEY]: { type: 'local' } } };
    removeOpencodeConfig(config);
    assert.equal(removeOpencodeConfig(config), false, 'second run is a no-op');
});

test('removeOpencodeConfig rejects bad inputs', () => {
    assert.throws(() => removeOpencodeConfig(null), /JSON object/);
    assert.throws(() => removeOpencodeConfig([]), /JSON object/);
});

test('parseArgs reads token from env and from --token, and rejects bad ones', () => {
    assert.equal(parseArgs([], { SIGILUM_TOKEN: 'viz_env' }).token, 'viz_env');
    assert.equal(parseArgs(['--token', 'viz_flag'], {}).token, 'viz_flag');
    assert.equal(parseArgs(['--token=viz_eq'], {}).token, 'viz_eq');
    assert.equal(parseArgs(['-t', 'viz_short'], {}).token, 'viz_short');

    // explicit flag overrides env
    assert.equal(parseArgs(['--token', 'viz_flag'], { SIGILUM_TOKEN: 'viz_env' }).token, 'viz_flag');

    assert.throws(() => parseArgs([], {}), /missing token/);
    assert.throws(() => parseArgs(['--token', 'not-a-token'], {}), /does not look valid/);
});

test('parseArgs honours the legacy VISUALIZER_* env names as fallbacks', () => {
    assert.equal(parseArgs([], { VISUALIZER_TOKEN: 'viz_legacy' }).token, 'viz_legacy');
    // The new name wins over the legacy one.
    assert.equal(
        parseArgs([], { SIGILUM_TOKEN: 'viz_new', VISUALIZER_TOKEN: 'viz_legacy' }).token,
        'viz_new'
    );
    assert.equal(parseArgs([], { SIGILUM_TOKEN: 'viz_x', VISUALIZER_URL: 'http://legacy:1' }).url, 'http://legacy:1');
});

test('parseArgs picks up --yes and SIGILUM_URL', () => {
    const opts = parseArgs(['--yes'], { SIGILUM_TOKEN: 'viz_x', SIGILUM_URL: 'http://h:1' });
    assert.equal(opts.yes, true);
    assert.equal(opts.url, 'http://h:1');
});

test('parseArgs --uninstall/-u needs no token and short-circuits validation', () => {
    assert.deepEqual(parseArgs(['--uninstall'], {}), { token: '', url: undefined, yes: false, uninstall: true });
    assert.equal(parseArgs(['-u'], {}).uninstall, true);
    // Even a malformed/absent token doesn't throw when uninstalling.
    assert.doesNotThrow(() => parseArgs(['--uninstall'], {}));
});
