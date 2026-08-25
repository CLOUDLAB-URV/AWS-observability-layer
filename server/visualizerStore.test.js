'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// visualizerStore resolves its storage root from persistRoot() at import time, so point
// PERSIST_DIR at an isolated temp dir BEFORE importing it (never touch the real persistence/).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vizstore-test-'));
process.env.PERSIST_DIR = tmp;
const store = await import('./visualizerStore.js');

const USER = 'usr_test';
const upsert = (id) => ({ op: 'upsert', type: 's3', id, name: id });

test('a new diagram defaults to Design (deployed:false)', async () => {
    await store.applyChanges(USER, 'design1', [upsert('a')]);
    const meta = await store.readMeta(USER, 'design1');
    assert.equal(meta.deployed, false);
});

test('deployed:true seeds a Live diagram, and later pushes preserve the flag', async () => {
    await store.applyChanges(USER, 'live1', [upsert('a')], undefined, true);
    assert.equal((await store.readMeta(USER, 'live1')).deployed, true);

    // A follow-up push without an explicit flag must NOT flip the mode.
    await store.applyChanges(USER, 'live1', [upsert('b')]);
    assert.equal((await store.readMeta(USER, 'live1')).deployed, true);
});

test('initialDeployed only seeds on creation, never flips an existing Design diagram', async () => {
    await store.applyChanges(USER, 'design2', [upsert('a')]); // created as Design
    await store.applyChanges(USER, 'design2', [upsert('b')], undefined, true); // late true ignored
    assert.equal((await store.readMeta(USER, 'design2')).deployed, false);
});

test('setDeployed transitions Design → Live and renameSession preserves the mode', async () => {
    await store.applyChanges(USER, 'design3', [upsert('a')]);
    await store.setDeployed(USER, 'design3', true);
    assert.equal((await store.readMeta(USER, 'design3')).deployed, true);

    const meta = await store.renameSession(USER, 'design3', 'My stack');
    assert.equal(meta.name, 'My stack');
    assert.equal(meta.deployed, true, 'rename must not drop the deployed flag');
});

test('listChats reports each diagram mode', async () => {
    const chats = await store.listChats(USER);
    const byId = Object.fromEntries(chats.map((c) => [c.chatId, c.deployed]));
    assert.equal(byId.design1, false);
    assert.equal(byId.live1, true);
    assert.equal(byId.design3, true);
});

test('upserts stamp per-resource deployed: inherited from the sigil mode by default', async () => {
    await store.applyChanges(USER, 'perres1', [upsert('a')]);                 // Design sigil
    await store.applyChanges(USER, 'perres2', [upsert('a')], undefined, true); // Live sigil
    const design = await store.readState(USER, 'perres1');
    const live = await store.readState(USER, 'perres2');
    assert.equal(design.a.deployed, false, 'Design resource inherits deployed:false');
    assert.equal(live.a.deployed, true, 'Live resource inherits deployed:true');
});

test('an explicit per-resource deployed divergence is stored verbatim with its note', async () => {
    await store.applyChanges(USER, 'perres3', [
        upsert('ok'),
        { ...upsert('failed'), deployed: false, deploy_note: 'create failed: AccessDenied' }
    ], undefined, true); // Live sigil with one failed resource
    const state = await store.readState(USER, 'perres3');
    assert.equal(state.ok.deployed, true);
    assert.equal(state.failed.deployed, false);
    assert.equal(state.failed.deploy_note, 'create failed: AccessDenied');
    assert.equal((await store.readMeta(USER, 'perres3')).deployed, true, 'sigil mode untouched');
});

test('a full-replace upsert clears a stale divergence and its note', async () => {
    await store.applyChanges(USER, 'perres4', [
        { ...upsert('a'), deployed: true, deploy_note: 'deployed early at user request' }
    ]); // Design sigil, one resource deployed early
    let state = await store.readState(USER, 'perres4');
    assert.equal(state.a.deployed, true);
    assert.equal(state.a.deploy_note, 'deployed early at user request');

    // Re-reporting the resource without the divergence fields resets it to the sigil mode.
    await store.applyChanges(USER, 'perres4', [upsert('a')]);
    state = await store.readState(USER, 'perres4');
    assert.equal(state.a.deployed, false, 'inherits Design mode again');
    assert.equal(state.a.deploy_note, undefined, 'stale note does not linger');
});

test('ask chat: empty by default, round-trips messages, clears with the sigil', async () => {
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), []);

    const at = new Date().toISOString();
    const messages = [
        { role: 'user', text: 'What is this?', at },
        { role: 'assistant', text: 'An S3 bucket.', at }
    ];
    await store.writeAskChat(USER, 'ask1', messages);
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), messages);

    await store.writeAskChat(USER, 'ask1', []); // the panel's Clear button
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), []);

    await store.deleteChat(USER, 'ask1');
    assert.deepEqual(await store.readAskChat(USER, 'ask1'), []);
});

test('ask chat: history is capped to the most recent 50 messages', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `msg ${i}`,
        at: new Date().toISOString()
    }));
    await store.writeAskChat(USER, 'ask2', many);
    const saved = await store.readAskChat(USER, 'ask2');
    assert.equal(saved.length, 50);
    assert.equal(saved[0].text, 'msg 70', 'keeps the newest, drops the oldest');
    assert.equal(saved[49].text, 'msg 119');
});

test('deploy_note is sticky while a resource stays divergent, and clears when it converges', async () => {
    const gw = (extra) => ({ op: 'upsert', type: 'api-gateway', id: 'gw', name: 'gw', ...extra });
    // Live sigil: the API Gateway failed to create → deployed:false + a reason.
    await store.applyChanges(USER, 'note-life', [gw({ deployed: false, deploy_note: 'create failed: AccessDenied' })], undefined, true);
    assert.equal((await store.readState(USER, 'note-life')).gw.deploy_note, 'create failed: AccessDenied');

    // A later enrichment re-push keeps it undeployed but omits the note → the reason must persist.
    await store.applyChanges(USER, 'note-life', [gw({ deployed: false, region: 'eu-west-1' })], undefined, true);
    const stillFailed = (await store.readState(USER, 'note-life')).gw;
    assert.equal(stillFailed.deploy_note, 'create failed: AccessDenied', 'reason kept while still failed');
    assert.equal(stillFailed.region, 'eu-west-1', 'the new field applied');

    // The create finally succeeds → deployed:true (converges to the Live sigil) → the stale note clears.
    await store.applyChanges(USER, 'note-life', [gw({ deployed: true, arn: 'arn:aws:apigateway:eu-west-1::/restapis/gw' })], undefined, true);
    const succeeded = (await store.readState(USER, 'note-life')).gw;
    assert.equal(succeeded.deployed, true);
    assert.equal(succeeded.deploy_note, undefined, 'note cleared once deployed');

    // A brand-new note always replaces the old one.
    await store.applyChanges(USER, 'note-life', [gw({ deployed: false, deploy_note: 'torn down at user request' })], undefined, true);
    assert.equal((await store.readState(USER, 'note-life')).gw.deploy_note, 'torn down at user request');
});

test('tearDown flips a Live sigil to Design, marks every resource undeployed and keeps them all', async () => {
    // Live sigil: one converged resource (deployed:true) and one divergent failed create.
    await store.applyChanges(USER, 'teardown-1', [
        { ...upsert('ok'), type: 'lambda', arn: 'arn:aws:lambda:eu-west-1:1:function:ok', code: [{ name: 'h.py', content: 'x\n' }] },
        { ...upsert('failed'), type: 'api-gateway', deployed: false, deploy_note: 'create failed: AccessDenied' }
    ], undefined, true);
    assert.equal((await store.readMeta(USER, 'teardown-1')).deployed, true);

    const resources = await store.tearDown(USER, 'teardown-1');

    // Sigil is Design now.
    assert.equal((await store.readMeta(USER, 'teardown-1')).deployed, false);
    // Both resources are KEPT (nothing deleted) — same node count.
    assert.equal(resources.length, 2);
    const state = await store.readState(USER, 'teardown-1');
    assert.ok(state.ok && state.failed, 'both resources still present');
    // Every resource is undeployed, and every divergence note is cleared.
    assert.equal(state.ok.deployed, false);
    assert.equal(state.failed.deployed, false);
    assert.equal(state.ok.deploy_note, undefined);
    assert.equal(state.failed.deploy_note, undefined, 'the failed-create reason is dropped on teardown');
    // Non-deploy fields survive.
    assert.equal(state.ok.arn, 'arn:aws:lambda:eu-west-1:1:function:ok');
    assert.deepEqual(state.ok.code, [{ name: 'h.py', content: 'x\n' }], 'code preserved through teardown');
});

test('after tearDown a codeless re-push inherits Design (deployed:false), and tearDown is idempotent', async () => {
    await store.applyChanges(USER, 'teardown-2', [upsert('a')], undefined, true); // Live
    await store.tearDown(USER, 'teardown-2');
    assert.equal((await store.readMeta(USER, 'teardown-2')).deployed, false);

    // A follow-up push with no explicit deployed flag inherits the (now Design) mode.
    await store.applyChanges(USER, 'teardown-2', [upsert('b')]);
    const state = await store.readState(USER, 'teardown-2');
    assert.equal(state.a.deployed, false);
    assert.equal(state.b.deployed, false);

    // Tearing down an already-Design sigil is a harmless no-op (the route guards it, but the
    // primitive must be safe too): stays Design, keeps every resource.
    const resources = await store.tearDown(USER, 'teardown-2');
    assert.equal((await store.readMeta(USER, 'teardown-2')).deployed, false);
    assert.equal(resources.length, 2);
});

test('code survives a codeless re-push (the deploy→Live re-report), and a new code replaces it', async () => {
    const code = [{ name: 'handler.py', language: 'python', content: 'def handler(e, c):\n    return 200\n' }];
    // Design push carries the code.
    await store.applyChanges(USER, 'code-life', [{ ...upsert('fn'), type: 'lambda', code }]);
    assert.deepEqual((await store.readState(USER, 'code-life')).fn.code, code);

    // Deploy re-report: same id, real arn, NO code → the design code must be preserved.
    await store.applyChanges(USER, 'code-life', [
        { ...upsert('fn'), type: 'lambda', arn: 'arn:aws:lambda:eu-west-1:1:function:fn', state: 'active' }
    ], undefined, true);
    const afterDeploy = (await store.readState(USER, 'code-life')).fn;
    assert.deepEqual(afterDeploy.code, code, 'code carried into the Live re-report');
    assert.equal(afterDeploy.arn, 'arn:aws:lambda:eu-west-1:1:function:fn', 'the new fields still applied');

    // Sending a new code array replaces it.
    const code2 = [{ name: 'handler.py', language: 'python', content: 'def handler(e, c):\n    return 201\n' }];
    await store.applyChanges(USER, 'code-life', [{ ...upsert('fn'), type: 'lambda', code: code2 }], undefined, true);
    assert.deepEqual((await store.readState(USER, 'code-life')).fn.code, code2, 'explicit new code replaces');
});

test('code preservation does not resurrect code after the resource is deleted and re-created', async () => {
    const code = [{ name: 'a.sh', content: 'echo hi\n' }];
    await store.applyChanges(USER, 'code-del', [{ ...upsert('r'), code }]);
    await store.applyChanges(USER, 'code-del', [{ op: 'delete', type: 's3', id: 'r' }]);
    await store.applyChanges(USER, 'code-del', [upsert('r')]); // fresh resource, no prior code
    assert.equal('code' in (await store.readState(USER, 'code-del')).r, false, 'starts with no code');
});

test('nameConflict: detects a duplicate case/space-insensitively, ignoring the excepted chat', async () => {
    await store.applyChanges(USER, 'name-a', [upsert('a')]);
    await store.renameSession(USER, 'name-a', 'Order Pipeline');

    assert.equal(await store.nameConflict(USER, 'order   pipeline'), true, 'case/space-insensitive match');
    assert.equal(await store.nameConflict(USER, 'Something else'), false);
    // The diagram itself doesn't count as a conflict when it's excepted (renaming to same name).
    assert.equal(await store.nameConflict(USER, 'Order Pipeline', 'name-a'), false);
    // A DIFFERENT chat with that name does conflict.
    assert.equal(await store.nameConflict(USER, 'Order Pipeline', 'other-chat'), true);
});

test('uniqueName: returns the base when free, else appends the first free numeric suffix', async () => {
    await store.applyChanges(USER, 'uniq-1', [upsert('a')]);
    await store.renameSession(USER, 'uniq-1', 'Pipeline');
    await store.applyChanges(USER, 'uniq-2', [upsert('a')]);
    await store.renameSession(USER, 'uniq-2', 'Pipeline 2');

    assert.equal(await store.uniqueName(USER, 'Fresh name'), 'Fresh name', 'free name kept as-is');
    // "Pipeline" and "Pipeline 2" are taken → next free is "Pipeline 3".
    assert.equal(await store.uniqueName(USER, 'Pipeline'), 'Pipeline 3');
    // Excepting the holder lets it keep its own name.
    assert.equal(await store.uniqueName(USER, 'Pipeline', 'uniq-1'), 'Pipeline');
});

test.after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
});

test('purpose survives the deploy re-report and is replaced only by a new one', async () => {
    const fn = (extra) => ({ op: 'upsert', type: 'lambda', id: 'fn', name: 'Orders service', ...extra });
    // Design phase: the agent explains what the resource is for.
    await store.applyChanges(USER, 'purpose-life', [fn({ purpose: 'Validates the order and writes it to the table.' })]);
    assert.equal(
        (await store.readState(USER, 'purpose-life')).fn.purpose,
        'Validates the order and writes it to the table.'
    );

    // Deploy re-report: real ARN, no purpose repeated — the role must not be erased.
    await store.applyChanges(USER, 'purpose-life', [fn({ arn: 'arn:aws:lambda:us-east-1:1:function:fn' })]);
    const afterDeploy = (await store.readState(USER, 'purpose-life')).fn;
    assert.equal(afterDeploy.purpose, 'Validates the order and writes it to the table.', 'role kept');
    assert.equal(afterDeploy.arn, 'arn:aws:lambda:us-east-1:1:function:fn');

    // A genuinely changed role replaces the stored one.
    await store.applyChanges(USER, 'purpose-life', [fn({ purpose: 'Now only enqueues the order.' })]);
    assert.equal((await store.readState(USER, 'purpose-life')).fn.purpose, 'Now only enqueues the order.');
});

test('network placement survives the deploy re-report and clears only on an explicit empty string', async () => {
    const ec2 = (extra) => ({ op: 'upsert', type: 'ec2', id: 'i-1', name: 'app', ...extra });
    const CHAT = 'placement-life';

    // Design phase: the agent states where the instance sits.
    await store.applyChanges(USER, CHAT, [ec2({ vpc: 'vpc-0abc', subnet: 'subnet-3c4d' })]);
    const designed = (await store.readState(USER, CHAT))['i-1'];
    assert.equal(designed.vpc, 'vpc-0abc');
    assert.equal(designed.subnet, 'subnet-3c4d');

    // Deploy re-report: real ARN, containment not repeated. The node must stay inside its subnet —
    // this is the regression that used to drop it straight out of the box.
    await store.applyChanges(USER, CHAT, [ec2({ arn: 'arn:aws:ec2:us-east-1:1:instance/i-1' })]);
    const live = (await store.readState(USER, CHAT))['i-1'];
    assert.equal(live.vpc, 'vpc-0abc', 'VPC kept');
    assert.equal(live.subnet, 'subnet-3c4d', 'subnet kept');
    assert.equal(live.arn, 'arn:aws:ec2:us-east-1:1:instance/i-1');

    // A new value replaces the stored one.
    await store.applyChanges(USER, CHAT, [ec2({ subnet: 'subnet-1a2b' })]);
    assert.equal((await store.readState(USER, CHAT))['i-1'].subnet, 'subnet-1a2b');

    // The empty-string sentinel takes it back out of the container for good.
    await store.applyChanges(USER, CHAT, [ec2({ vpc: '', subnet: '' })]);
    const freed = (await store.readState(USER, CHAT))['i-1'];
    assert.equal('vpc' in freed, false);
    assert.equal('subnet' in freed, false);
});

test('a subnet keeps its public/private scope across a partial upsert', async () => {
    const subnet = (extra) => ({ op: 'upsert', type: 'subnet', id: 'subnet-1a2b', ...extra });
    const CHAT = 'scope-life';

    await store.applyChanges(USER, CHAT, [subnet({ scope: 'public', vpc: 'vpc-0abc' })]);
    assert.equal((await store.readState(USER, CHAT))['subnet-1a2b'].scope, 'public');

    // Later push carries only the real AZ: the scope must not be lost, or the box loses its colour.
    await store.applyChanges(USER, CHAT, [subnet({ details: { AvailabilityZone: 'us-east-1a' } })]);
    const after = (await store.readState(USER, CHAT))['subnet-1a2b'];
    assert.equal(after.scope, 'public');
    assert.equal(after.vpc, 'vpc-0abc');

    await store.applyChanges(USER, CHAT, [subnet({ scope: 'private' })]);
    assert.equal((await store.readState(USER, CHAT))['subnet-1a2b'].scope, 'private');
});

test('attachments survive the deploy re-report and are replaced only by a new array', async () => {
    const fn = (extra) => ({ op: 'upsert', type: 'lambda', id: 'checkout-fn', ...extra });
    const CHAT = 'attachments-life';
    const role = { type: 'iam-role', id: 'checkout-fn-role', purpose: 'Reads the orders table.' };

    // Design phase: the role is planned alongside the function.
    await store.applyChanges(USER, CHAT, [fn({ attachments: [role] })]);
    assert.deepEqual((await store.readState(USER, CHAT))['checkout-fn'].attachments, [role]);

    // Deploy re-report: real ARN, attachments not repeated — the role must not be erased.
    await store.applyChanges(USER, CHAT, [fn({ arn: 'arn:aws:lambda:us-east-1:1:function:checkout-fn' })]);
    const live = (await store.readState(USER, CHAT))['checkout-fn'];
    assert.deepEqual(live.attachments, [role], 'attachments kept');
    assert.equal(live.arn, 'arn:aws:lambda:us-east-1:1:function:checkout-fn');

    // A new array replaces the stored one wholesale.
    const sg = { type: 'security-group', id: 'sg-0ab1' };
    await store.applyChanges(USER, CHAT, [fn({ attachments: [sg] })]);
    assert.deepEqual((await store.readState(USER, CHAT))['checkout-fn'].attachments, [sg]);
});
