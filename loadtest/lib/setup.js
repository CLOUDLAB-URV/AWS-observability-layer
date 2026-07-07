'use strict';

// Provisions the virtual users for a load-test run against a SCRATCH backend:
// register → verify (the code comes back in the response because the scratch
// server has no SMTP configured) → login session cookie → mint one MCP token.
//
// Emails embed a per-run id so re-runs against the same persist dir never
// collide with earlier accounts (each run gets fresh users and fresh tokens).

async function api(base, path, { method = 'POST', body, cookie } = {}) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try {
        json = await res.json();
    } catch {
        // non-JSON error body — leave null
    }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') || '' };
}

// One virtual user: returns { index, email, token, chatId }.
async function provisionUser(base, runId, index) {
    const email = `loadtest-${runId}-${index}@example.test`;
    const username = `loadtest${runId}${index}`;
    const password = `Loadtest!${runId}-${index}`;

    const reg = await api(base, '/api/auth/register', { body: { email, username, password } });
    if (reg.status !== 200) {
        throw new Error(`register u${index} failed (${reg.status}): ${reg.json?.error ?? 'unknown'}`);
    }
    if (!reg.json?.devCode) {
        throw new Error(
            `register u${index}: no devCode in response — the target server has SMTP configured. ` +
            'Run the load test against a scratch server WITHOUT SMTP_* set.'
        );
    }

    const verify = await api(base, '/api/auth/verify', { body: { email, code: reg.json.devCode } });
    if (verify.status !== 200) {
        throw new Error(`verify u${index} failed (${verify.status}): ${verify.json?.error ?? 'unknown'}`);
    }
    const cookie = verify.setCookie.split(';')[0];
    if (!cookie) {
        throw new Error(`verify u${index}: no session cookie returned`);
    }

    const tok = await api(base, '/api/tokens', { body: { label: `loadtest ${runId}` }, cookie });
    if (tok.status !== 200 || !tok.json?.token) {
        throw new Error(
            `token u${index} failed (${tok.status}): ${tok.json?.error ?? 'unknown'}` +
            (tok.json?.dev || tok.status === 403 ? ' — start the scratch server with NODE_ENV=production' : '')
        );
    }

    return { index, email, token: tok.json.token, chatId: `loadtest-${runId}-u${index}` };
}

// Provisions all users with mild parallelism (the auth store serializes writes
// globally, so a full 20-wide burst here would just queue anyway).
export async function provisionUsers(base, count) {
    const runId = Date.now().toString(36).slice(-6);
    const users = [];
    const batchSize = 5;
    for (let start = 0; start < count; start += batchSize) {
        const batch = await Promise.all(
            Array.from({ length: Math.min(batchSize, count - start) }, (_, i) =>
                provisionUser(base, runId, start + i)
            )
        );
        users.push(...batch);
        process.stdout.write(`\r  provisioned ${users.length}/${count} users`);
    }
    process.stdout.write('\n');
    return { runId, users };
}
