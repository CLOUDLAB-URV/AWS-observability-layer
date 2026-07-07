'use strict';

// Concurrency + retry guard for outbound LLM (Vertex Gemini) calls.
//
// Vertex Gemini 2.5 runs on Dynamic Shared Quota: there is no fixed per-project
// RPM — under contention the API intermittently returns 429 RESOURCE_EXHAUSTED.
// Every server-side Gemini call goes through this module (wired in client.js) so
// that a burst of concurrent users fans out to at most LLM_MAX_CONCURRENT
// in-flight requests (the rest wait in a FIFO queue) and transient quota errors
// are absorbed with exponential backoff instead of failing the request.

// Default sized from load testing: a stateviz generation runs ~25-30s on Flash,
// so sustaining ~20 users pushing every 30s (~0.7 calls/s) needs ~16-20 slots.
const MAX_CONCURRENT = clampInt(process.env.LLM_MAX_CONCURRENT, 16, 1, 64);
const QUEUE_TIMEOUT_MS = clampInt(process.env.LLM_QUEUE_TIMEOUT_MS, 120_000, 1_000, 600_000);
const MAX_ATTEMPTS = 3;

function clampInt(raw, fallback, min, max) {
    const value = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// FIFO semaphore
// ---------------------------------------------------------------------------
let inFlight = 0;
const waiters = []; // [{ resolve, reject, timer }]

export function llmStats() {
    return { inFlight, queued: waiters.length, maxConcurrent: MAX_CONCURRENT };
}

function acquire() {
    if (inFlight < MAX_CONCURRENT) {
        inFlight++;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) {
                waiters.splice(index, 1);
            }
            reject(new Error(`LLM call queued for more than ${QUEUE_TIMEOUT_MS}ms (server saturated)`));
        }, QUEUE_TIMEOUT_MS);
        waiter.timer.unref?.();
        waiters.push(waiter);
    });
}

function release() {
    const next = waiters.shift();
    if (next) {
        clearTimeout(next.timer);
        next.resolve(); // hand the slot straight over; inFlight count is unchanged
    } else {
        inFlight--;
    }
}

// Run `task` while holding one of the LLM_MAX_CONCURRENT slots.
export async function withLimit(task) {
    const queuedAt = waiters.length > 0 || inFlight >= MAX_CONCURRENT ? Date.now() : 0;
    await acquire();
    if (queuedAt) {
        console.log(`[llm] call waited ${Date.now() - queuedAt}ms for a slot (in-flight ${inFlight}/${MAX_CONCURRENT})`);
    }
    try {
        return await task();
    } finally {
        release();
    }
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter (quota / transient errors only)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => Math.min(8000, 2 ** attempt * 1000) + Math.floor(Math.random() * 500);

const RETRYABLE_STATUS = new Set([429, 500, 503]);
const RETRYABLE_MESSAGE = /RESOURCE_EXHAUSTED|UNAVAILABLE|quota|rate.?limit|overloaded|429|503/i;

export function isRetryableLlmError(error) {
    const status = error?.status ?? error?.code;
    if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) {
        return true;
    }
    return RETRYABLE_MESSAGE.test(String(error?.message ?? ''));
}

// Run `task` (which must acquire its own slot per attempt, so a backoff sleep
// never holds capacity), retrying transient quota errors. `canRetry()` lets the
// caller veto a retry once partial output has already been streamed to a client.
export async function withRetry(task, { maxAttempts = MAX_ATTEMPTS, canRetry = () => true } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await task();
        } catch (error) {
            if (attempt >= maxAttempts - 1 || !isRetryableLlmError(error) || !canRetry()) {
                throw error;
            }
            const delay = backoffMs(attempt);
            console.warn(`[llm] transient error (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms: ${error?.message}`);
            await sleep(delay);
        }
    }
}
