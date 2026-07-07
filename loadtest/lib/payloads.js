'use strict';

// Synthetic sigil payloads for the load test. Each virtual user pushes an
// evolving AWS deployed-state so the server's stateviz agent gets a realistic,
// non-trivial input that CHANGES on every iteration (previous D2 + new
// inventory), exactly like a real agent pushing incremental changes.

// Base architecture every virtual user starts from (a small but connected
// design: VPC → subnet → EC2 + RDS, plus S3/SQS/Lambda around it).
function baseResources(user) {
    const suffix = `u${user}`;
    return [
        { type: 'vpc', id: `vpc-${suffix}`, name: `loadtest-vpc-${suffix}`, state: 'available', details: { cidr: '10.0.0.0/16' } },
        { type: 'subnet', id: `subnet-${suffix}`, name: `public-a`, vpc: `vpc-${suffix}`, state: 'available', details: { cidr: '10.0.1.0/24', az: 'us-east-1a' } },
        { type: 'ec2', id: `i-${suffix}0001`, name: `web-${suffix}`, subnet: `subnet-${suffix}`, vpc: `vpc-${suffix}`, state: 'running', connections: [`sqs-orders-${suffix}`], details: { instanceType: 't3.micro' } },
        { type: 's3', id: `assets-${suffix}`, name: `assets-${suffix}`, state: 'active', details: { versioning: true } },
        { type: 'sqs', id: `sqs-orders-${suffix}`, name: `orders-${suffix}`, state: 'active', connections: [`lambda-worker-${suffix}`], details: { visibilityTimeout: 30 } },
        { type: 'lambda', id: `lambda-worker-${suffix}`, name: `worker-${suffix}`, state: 'active', connections: [`assets-${suffix}`], details: { runtime: 'nodejs20.x', memory: 256 } }
    ];
}

// Per-iteration mutations, cycled: grow the architecture, flip states, retire a
// resource — so consecutive pushes are never byte-identical and the diagram
// genuinely evolves.
function mutation(user, iteration) {
    const suffix = `u${user}`;
    const n = iteration; // 1-based
    switch (n % 4) {
        case 1: // add a new lambda hooked to the queue
            return [{
                op: 'upsert', type: 'lambda', id: `lambda-extra-${suffix}-${n}`,
                name: `extra-${suffix}-${n}`, state: 'active',
                connections: [`sqs-orders-${suffix}`], details: { runtime: 'python3.12', iteration: n }
            }];
        case 2: // scale the web tier with one more instance
            return [{
                op: 'upsert', type: 'ec2', id: `i-${suffix}${String(n).padStart(4, '0')}`,
                name: `web-${suffix}-${n}`, subnet: `subnet-${suffix}`, vpc: `vpc-${suffix}`,
                state: 'running', details: { instanceType: 't3.small', iteration: n }
            }];
        case 3: // flip an instance state (update in place)
            return [{
                op: 'upsert', type: 'ec2', id: `i-${suffix}0001`,
                name: `web-${suffix}`, subnet: `subnet-${suffix}`, vpc: `vpc-${suffix}`,
                state: n % 8 === 3 ? 'stopped' : 'running', connections: [`sqs-orders-${suffix}`],
                details: { instanceType: 't3.micro', iteration: n }
            }];
        default: // retire the oldest extra lambda, if any
            return [{
                op: 'delete', type: 'lambda', id: `lambda-extra-${suffix}-${Math.max(1, n - 3)}`
            }];
    }
}

// Body for POST /api/chats/:chatId/deployments. Iteration 0 seeds the base
// architecture (with a project-name hint so the run doesn't also trigger the
// auto-naming LLM call — one Gemini call per push keeps the math predictable);
// later iterations push one incremental change.
export function buildPushBody(user, iteration) {
    if (iteration === 0) {
        return {
            project: `Load test u${user}`,
            deployed: false,
            changes: baseResources(user).map((resource) => ({ op: 'upsert', ...resource }))
        };
    }
    return { deployed: false, changes: mutation(user, iteration) };
}

// Dry-run body (--no-ai): a delete for a resource that never exists keeps the
// chat's inventory empty, so the server skips both Gemini calls entirely while
// still exercising auth, ingest, the per-chat write queue and the render path.
export function buildNoAiBody(user, iteration) {
    return {
        project: `Load test u${user}`,
        deployed: false,
        changes: [{ op: 'delete', type: 'ec2', id: `ghost-u${user}-${iteration}` }]
    };
}
