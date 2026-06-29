'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOpencodeConfig, parseArgs, SERVER_KEY, OPENCODE_SCHEMA } from './config.js';

test('creates the full entry (and $schema) from an empty config', () => {
    const out = applyOpencodeConfig({}, { token: 'viz_abc123' });
    assert.equal(out.$schema, OPENCODE_SCHEMA);
    const entry = out.mcp[SERVER_KEY];
    assert.equal(entry.type, 'local');
    assert.deepEqual(entry.command, ['npx', '-y', 'diagram-state-visualizer-mcp@latest']);
    assert.equal(entry.enabled, true);
    assert.equal(entry.environment.VISUALIZER_TOKEN, 'viz_abc123');
    assert.equal('VISUALIZER_URL' in entry.environment, false);
});

test('includes VISUALIZER_URL only when provided, and only on creation', () => {
    const out = applyOpencodeConfig({}, { token: 'viz_abc', url: 'http://127.0.0.1:3001' });
    assert.equal(out.mcp[SERVER_KEY].environment.VISUALIZER_URL, 'http://127.0.0.1:3001');
});

test('adds the entry when mcp exists but has other servers, preserving them', () => {
    const config = { $schema: 'x', mcp: { other: { type: 'local', enabled: true } } };
    const out = applyOpencodeConfig(config, { token: 'viz_new' });
    assert.deepEqual(out.mcp.other, { type: 'local', enabled: true }, 'other server untouched');
    assert.equal(out.mcp[SERVER_KEY].environment.VISUALIZER_TOKEN, 'viz_new');
    assert.equal(out.$schema, 'x', 'existing $schema not overwritten');
});

test('re-run only updates the token, preserving every other field', () => {
    const config = {
        mcp: {
            [SERVER_KEY]: {
                type: 'local',
                command: ['node', '/custom/path.js'],   // user customised
                enabled: false,                          // user customised
                environment: { VISUALIZER_TOKEN: 'viz_old', EXTRA: 'keep-me' },
                customField: 123
            }
        }
    };
    const out = applyOpencodeConfig(config, { token: 'viz_fresh', url: 'http://ignored' });
    const entry = out.mcp[SERVER_KEY];
    assert.equal(entry.environment.VISUALIZER_TOKEN, 'viz_fresh', 'token refreshed');
    assert.equal(entry.environment.EXTRA, 'keep-me', 'extra env preserved');
    assert.deepEqual(entry.command, ['node', '/custom/path.js'], 'custom command preserved');
    assert.equal(entry.enabled, false, 'enabled flag preserved');
    assert.equal(entry.customField, 123, 'extra field preserved');
    assert.equal('VISUALIZER_URL' in entry.environment, false, 'url not added on re-run');
});

test('creates environment if a malformed entry lacks one', () => {
    const config = { mcp: { [SERVER_KEY]: { type: 'local', enabled: true } } };
    const out = applyOpencodeConfig(config, { token: 'viz_x' });
    assert.equal(out.mcp[SERVER_KEY].environment.VISUALIZER_TOKEN, 'viz_x');
});

test('applyOpencodeConfig rejects bad inputs', () => {
    assert.throws(() => applyOpencodeConfig(null, { token: 'viz_x' }), /JSON object/);
    assert.throws(() => applyOpencodeConfig([], { token: 'viz_x' }), /JSON object/);
    assert.throws(() => applyOpencodeConfig({}, {}), /token is required/);
});

test('parseArgs reads token from env and from --token, and rejects bad ones', () => {
    assert.equal(parseArgs([], { VISUALIZER_TOKEN: 'viz_env' }).token, 'viz_env');
    assert.equal(parseArgs(['--token', 'viz_flag'], {}).token, 'viz_flag');
    assert.equal(parseArgs(['--token=viz_eq'], {}).token, 'viz_eq');
    assert.equal(parseArgs(['-t', 'viz_short'], {}).token, 'viz_short');

    // explicit flag overrides env
    assert.equal(parseArgs(['--token', 'viz_flag'], { VISUALIZER_TOKEN: 'viz_env' }).token, 'viz_flag');

    assert.throws(() => parseArgs([], {}), /missing token/);
    assert.throws(() => parseArgs(['--token', 'not-a-token'], {}), /does not look valid/);
});

test('parseArgs picks up --yes and VISUALIZER_URL', () => {
    const opts = parseArgs(['--yes'], { VISUALIZER_TOKEN: 'viz_x', VISUALIZER_URL: 'http://h:1' });
    assert.equal(opts.yes, true);
    assert.equal(opts.url, 'http://h:1');
});
