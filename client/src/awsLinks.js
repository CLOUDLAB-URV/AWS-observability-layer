// AWS console deep links, built deterministically from the resource record — the agent
// never has to supply a URL. For a deployed resource `consoleUrl()` ALWAYS returns
// something: an exact deep link when the service is mapped and the id/name suffices,
// otherwise that service's console page (or the region's console home as the universal
// fallback), so "Open in AWS Console" is never missing.

const ARN_RE = /^arn:aws[a-z0-9-]*:/;
const isArn = (v) => typeof v === 'string' && ARN_RE.test(v.trim());

// Shallow scan (≤2 levels) of an object for the first ARN-shaped string value — covers the
// common describe/create output keys (FunctionArn, TopicArn, DBInstanceArn, Arn, …) the agent
// buries in `details`, without walking arbitrarily deep JSON.
function scanForArn(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 2) return '';
    for (const value of Object.values(obj)) {
        if (isArn(value)) return value.trim();
    }
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const found = scanForArn(value, depth + 1);
            if (found) return found;
        }
    }
    return '';
}

// The resource ARN: explicit `arn` field, an ARN-shaped `id`, or the first ARN found anywhere
// in the free-form `details` blob. Empty string when the resource carries none.
export function resourceArn(resource) {
    if (!resource || typeof resource !== 'object') return '';
    if (isArn(resource.arn)) return resource.arn.trim();
    if (isArn(resource.id)) return resource.id.trim();
    return scanForArn(resource.details);
}

// Alias kept for callers that read the ARN for display (tooltip / copy button).
export const findArn = (resource) => resourceArn(resource) || null;

// Middle-ellipsis for long ARNs in tight UI (tooltip): keep the service head + resource tail.
export function shortArn(arn, max = 44) {
    if (typeof arn !== 'string' || arn.length <= max) return arn;
    const head = Math.ceil((max - 1) * 0.45);
    const tail = max - 1 - head;
    return `${arn.slice(0, head)}…${arn.slice(-tail)}`;
}

// arn:partition:service:region:account:rest → { service, region, account, rest }
function parseArn(arn) {
    const parts = String(arn || '').split(':');
    if (parts.length < 6 || parts[0] !== 'arn') return null;
    return { service: parts[2], region: parts[3], account: parts[4], rest: parts.slice(5).join(':') };
}

// Best-known region for the resource: explicit field → ARN → us-east-1.
export function resourceRegion(resource) {
    if (resource?.region && typeof resource.region === 'string') return resource.region.trim();
    const arn = parseArn(resourceArn(resource));
    if (arn?.region) return arn.region;
    return 'us-east-1';
}

// Normalize the free-form `type` the agent sent into a canonical service key.
function serviceKey(type) {
    const t = String(type || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const ALIASES = {
        dynamo: 'dynamodb', dynamodbtable: 'dynamodb',
        apigw: 'apigateway', apigatewayv2: 'apigateway', httpapi: 'apigateway',
        alb: 'elb', elbv2: 'elb', loadbalancer: 'elb', nlb: 'elb',
        logs: 'cloudwatch', cloudwatchlogs: 'cloudwatch',
        sfn: 'stepfunctions', states: 'stepfunctions', statemachine: 'stepfunctions',
        redis: 'elasticache', memcached: 'elasticache',
        function: 'lambda', lambdafunction: 'lambda',
        bucket: 's3', s3bucket: 's3',
        instance: 'ec2', ec2instance: 'ec2',
        securitygroup: 'sg', natgateway: 'nat', internetgateway: 'igw',
        userpool: 'cognito', cognitouserpool: 'cognito',
        queue: 'sqs', topic: 'sns', stream: 'kinesis',
        db: 'rds', database: 'rds', aurora: 'rds'
    };
    return ALIASES[t] || t;
}

const REGION_HOST = (r) => `https://${r}.console.aws.amazon.com`;

// Per-service link builders. Each gets ({ id, name, region, arn }) — `id`/`name` already
// trimmed — and returns a URL, or null to fall through to the universal fallback.
const BUILDERS = {
    ec2({ id, region }) {
        if (/^i-[0-9a-f]+$/i.test(id)) {
            return `${REGION_HOST(region)}/ec2/home?region=${region}#InstanceDetails:instanceId=${id}`;
        }
        return `${REGION_HOST(region)}/ec2/home?region=${region}#Instances:`;
    },
    s3({ id, name }) {
        const bucket = name || id;
        return bucket ? `https://console.aws.amazon.com/s3/buckets/${encodeURIComponent(bucket)}` : null;
    },
    lambda({ id, name, region }) {
        const fn = name || id;
        return `${REGION_HOST(region)}/lambda/home?region=${region}#/functions/${encodeURIComponent(fn)}`;
    },
    rds({ id, name, region }) {
        const db = id || name;
        return `${REGION_HOST(region)}/rds/home?region=${region}#database:id=${encodeURIComponent(db)}`;
    },
    dynamodb({ id, name, region }) {
        const table = name || id;
        return `${REGION_HOST(region)}/dynamodbv2/home?region=${region}#table?name=${encodeURIComponent(table)}`;
    },
    sqs({ id, region }) {
        // Deep link needs the full queue URL; the id often is one. Otherwise, queue list.
        if (/^https:\/\//.test(id)) {
            return `${REGION_HOST(region)}/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(id)}`;
        }
        return `${REGION_HOST(region)}/sqs/v3/home?region=${region}#/queues`;
    },
    sns({ region, arn }) {
        if (arn) return `${REGION_HOST(region)}/sns/v3/home?region=${region}#/topic/${arn}`;
        return `${REGION_HOST(region)}/sns/v3/home?region=${region}#/topics`;
    },
    vpc({ id, region }) {
        if (/^vpc-/.test(id)) {
            return `${REGION_HOST(region)}/vpcconsole/home?region=${region}#VpcDetails:VpcId=${id}`;
        }
        return `${REGION_HOST(region)}/vpcconsole/home?region=${region}#vpcs:`;
    },
    subnet({ id, region }) {
        if (/^subnet-/.test(id)) {
            return `${REGION_HOST(region)}/vpcconsole/home?region=${region}#SubnetDetails:subnetId=${id}`;
        }
        return `${REGION_HOST(region)}/vpcconsole/home?region=${region}#subnets:`;
    },
    sg({ id, region }) {
        if (/^sg-/.test(id)) {
            return `${REGION_HOST(region)}/ec2/home?region=${region}#SecurityGroup:groupId=${id}`;
        }
        return `${REGION_HOST(region)}/ec2/home?region=${region}#SecurityGroups:`;
    },
    nat({ region }) { return `${REGION_HOST(region)}/vpcconsole/home?region=${region}#NatGateways:`; },
    igw({ region }) { return `${REGION_HOST(region)}/vpcconsole/home?region=${region}#igws:`; },
    apigateway({ id, region }) {
        // REST/HTTP api ids are short tokens; anything else lands on the API list.
        if (/^[a-z0-9]{8,12}$/i.test(id)) {
            return `${REGION_HOST(region)}/apigateway/main/apis/${id}/resources?api=${id}&region=${region}`;
        }
        return `${REGION_HOST(region)}/apigateway/main/apis?region=${region}`;
    },
    cloudfront({ id }) {
        if (/^E[A-Z0-9]+$/.test(id)) {
            return `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${id}`;
        }
        return 'https://console.aws.amazon.com/cloudfront/v4/home#/distributions';
    },
    ecs({ id, name, region }) {
        const cluster = name || id;
        return `${REGION_HOST(region)}/ecs/v2/clusters/${encodeURIComponent(cluster)}?region=${region}`;
    },
    eks({ id, name, region }) {
        const cluster = name || id;
        return `${REGION_HOST(region)}/eks/home?region=${region}#/clusters/${encodeURIComponent(cluster)}`;
    },
    kinesis({ id, name, region }) {
        const stream = name || id;
        return `${REGION_HOST(region)}/kinesis/home?region=${region}#/streams/details/${encodeURIComponent(stream)}`;
    },
    elasticache({ region }) { return `${REGION_HOST(region)}/elasticache/home?region=${region}#/`; },
    iam({ id, name }) {
        const role = name || id;
        return role
            ? `https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(role)}`
            : 'https://console.aws.amazon.com/iam/home#/roles';
    },
    cognito({ id, region }) {
        if (/^[a-z]{2}-[a-z-]+-\d_[A-Za-z0-9]+$/.test(id)) {
            return `${REGION_HOST(region)}/cognito/v2/idp/user-pools/${id}/users?region=${region}`;
        }
        return `${REGION_HOST(region)}/cognito/v2/idp/user-pools?region=${region}`;
    },
    sagemaker({ id, name, region }) {
        const endpoint = name || id;
        return `${REGION_HOST(region)}/sagemaker/home?region=${region}#/endpoints/${encodeURIComponent(endpoint)}`;
    },
    elb({ region }) { return `${REGION_HOST(region)}/ec2/home?region=${region}#LoadBalancers:`; },
    cloudwatch({ region }) { return `${REGION_HOST(region)}/cloudwatch/home?region=${region}#logsV2:log-groups`; },
    secretsmanager({ id, name, region }) {
        const secret = name || id;
        return `${REGION_HOST(region)}/secretsmanager/secret?name=${encodeURIComponent(secret)}&region=${region}`;
    },
    stepfunctions({ region, arn }) {
        if (arn) return `${REGION_HOST(region)}/states/home?region=${region}#/statemachines/view/${encodeURIComponent(arn)}`;
        return `${REGION_HOST(region)}/states/home?region=${region}#/statemachines`;
    },
    mediaconvert({ region }) { return `${REGION_HOST(region)}/mediaconvert/home?region=${region}`; },
    route53() { return 'https://console.aws.amazon.com/route53/v2/hostedzones#'; }
};

// Agent-supplied override, accepted ONLY on the real AWS console host — anything else is
// dropped so a malicious/buggy push can't plant an arbitrary link in the UI.
function safeOverride(resource) {
    const candidate = resource?.consoleUrl || resource?.details?.consoleUrl;
    if (typeof candidate !== 'string') return '';
    try {
        const u = new URL(candidate);
        if (u.protocol !== 'https:') return '';
        const host = u.hostname;
        if (host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com')) {
            return candidate;
        }
    } catch { /* not a URL */ }
    return '';
}

// The link for "Open in AWS Console". Never returns null: unknown services land on the
// region's console home, so a deployed resource ALWAYS has a link.
export function consoleUrl(resource) {
    const override = safeOverride(resource);
    if (override) return override;

    const region = resourceRegion(resource);
    const arn = resourceArn(resource);
    const args = {
        id: String(resource?.id ?? '').trim(),
        name: String(resource?.name ?? '').trim(),
        region,
        arn
    };
    const builder = BUILDERS[serviceKey(resource?.type)];
    const url = builder ? builder(args) : null;
    if (url) return url;
    // No dedicated builder: if we have an ARN, hand it to AWS's official resolver (opens the
    // exact resource in whatever console owns it); otherwise fall back to the region's console
    // home so the link is never missing.
    if (arn) return `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn)}`;
    return `${REGION_HOST(region)}/console/home?region=${region}`;
}
