'use strict';

// Metrics collector + pretty console reporting for the load test. Zero-dep:
// records one sample per request and renders an aligned summary table at the end.

export class Metrics {
    constructor() {
        this.samples = []; // { ok, status, ms, error }
        this.startedAt = Date.now();
    }

    record({ ok, status, ms, error }) {
        this.samples.push({ ok, status, ms, error: error || null });
    }

    get okCount() {
        return this.samples.filter((s) => s.ok).length;
    }

    get failCount() {
        return this.samples.length - this.okCount;
    }

    latencies() {
        return this.samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
    }

    percentile(p) {
        const sorted = this.latencies();
        if (sorted.length === 0) {
            return 0;
        }
        const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
        return sorted[Math.max(0, index)];
    }

    // Failure counts grouped by HTTP status (or transport-error label).
    failuresByKind() {
        const byKind = new Map();
        for (const s of this.samples) {
            if (s.ok) {
                continue;
            }
            const kind = s.status ? `HTTP ${s.status}` : (s.error?.includes('abort') ? 'timeout' : 'network');
            byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
        }
        return byKind;
    }

    summary() {
        const elapsed = (Date.now() - this.startedAt) / 1000;
        return {
            requests: this.samples.length,
            ok: this.okCount,
            failed: this.failCount,
            rps: elapsed > 0 ? this.samples.length / elapsed : 0,
            p50: this.percentile(50),
            p95: this.percentile(95),
            p99: this.percentile(99),
            max: this.latencies().at(-1) ?? 0,
            elapsedSec: elapsed
        };
    }
}

const fmtMs = (ms) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

// Renders the final report as an aligned table (same plain-text style as the
// operator CLI in server/scripts/admin-cli.js).
export function renderReport(metrics, { label }) {
    const s = metrics.summary();
    const rows = [
        ['requests', String(s.requests)],
        ['ok', String(s.ok)],
        ['failed', String(s.failed)],
        ['throughput', `${s.rps.toFixed(2)} req/s`],
        ['latency p50', fmtMs(s.p50)],
        ['latency p95', fmtMs(s.p95)],
        ['latency p99', fmtMs(s.p99)],
        ['latency max', fmtMs(s.max)],
        ['wall time', `${s.elapsedSec.toFixed(1)}s`]
    ];
    for (const [kind, count] of metrics.failuresByKind()) {
        rows.push([`  └ ${kind}`, String(count)]);
    }

    const width = Math.max(...rows.map(([k]) => k.length));
    const lines = [
        '',
        `── ${label} ${'─'.repeat(Math.max(4, 46 - label.length))}`,
        ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
        `${'─'.repeat(50)}`,
        ''
    ];
    return lines.join('\n');
}
