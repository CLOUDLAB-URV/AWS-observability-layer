'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLimit, withRetry, llmStats, isRetryableLlmError } from './agents/shared/limiter.js';

// Pure in-process tests for the LLM concurrency/retry guard (no network, no
// persistence). Default cap is LLM_MAX_CONCURRENT=4 — these tests assume the
// env var is unset when the suite runs.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('semaphore never exceeds the concurrency cap under a 20-task burst', async () => {
    const cap = llmStats().maxConcurrent;
    let running = 0;
    let peak = 0;

    await Promise.all(
        Array.from({ length: 20 }, () =>
            withLimit(async () => {
                running++;
                peak = Math.max(peak, running);
                await sleep(10);
                running--;
            })
        )
    );

    assert.equal(peak, cap, `peak concurrency ${peak} should equal the cap ${cap}`);
    assert.deepEqual(llmStats(), { inFlight: 0, queued: 0, maxConcurrent: cap });
});

test('queued tasks run in FIFO order', async () => {
    const cap = llmStats().maxConcurrent;
    const started = [];
    const tasks = [];

    // Fill every slot with blockers we control, so tasks 0..5 all queue.
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    for (let i = 0; i < cap; i++) {
        tasks.push(withLimit(() => gate));
    }
    for (let i = 0; i < 6; i++) {
        tasks.push(withLimit(async () => { started.push(i); }));
    }

    unblock();
    await Promise.all(tasks);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
});

test('a failing task releases its slot', async () => {
    await assert.rejects(withLimit(() => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(llmStats().inFlight, 0);
});

test('withRetry retries transient quota errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 3) {
            const error = new Error('RESOURCE_EXHAUSTED: Quota exceeded');
            error.status = 429;
            throw error;
        }
        return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('withRetry does not retry non-retryable errors', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            const error = new Error('INVALID_ARGUMENT: bad request');
            error.status = 400;
            throw error;
        }),
        /INVALID_ARGUMENT/
    );
    assert.equal(calls, 1);
});

test('withRetry stops when canRetry vetoes (partial output already streamed)', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(
            async () => {
                calls++;
                const error = new Error('got 429 mid-stream');
                error.status = 429;
                throw error;
            },
            { canRetry: () => false }
        ),
        /mid-stream/
    );
    assert.equal(calls, 1);
});

test('withRetry gives up after maxAttempts', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(
            async () => {
                calls++;
                const error = new Error('overloaded');
                error.status = 503;
                throw error;
            },
            { maxAttempts: 2 }
        ),
        /overloaded/
    );
    assert.equal(calls, 2);
});

test('isRetryableLlmError classifies by status code and message', () => {
    assert.equal(isRetryableLlmError({ status: 429 }), true);
    assert.equal(isRetryableLlmError({ status: 503 }), true);
    assert.equal(isRetryableLlmError({ message: 'RESOURCE_EXHAUSTED' }), true);
    assert.equal(isRetryableLlmError({ message: 'model is overloaded' }), true);
    assert.equal(isRetryableLlmError({ status: 400, message: 'bad schema' }), false);
    assert.equal(isRetryableLlmError(new Error('permission denied')), false);
});
