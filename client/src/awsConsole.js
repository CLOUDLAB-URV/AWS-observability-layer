// Pure helpers to surface a deployed resource's AWS identity: find its ARN (explicit field,
// ARN-shaped id, or buried in the free-form `details` blob the agent pushed) and build a deep
// link into the AWS console for it. Only meaningful on Live sigils — Design resources don't
// exist in AWS, so callers gate on `deployed` before using these.

const ARN_RE = /^arn:aws[a-z0-9-]*:/;

function isArn(value) {
    return typeof value === 'string' && ARN_RE.test(value.trim());
}

// Shallow scan (2 levels) of an object for the first ARN-shaped string value. Covers the
// common AWS describe/create output keys (FunctionArn, TopicArn, DBInstanceArn, Arn, …)
// without walking arbitrarily deep JSON.
function scanForArn(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 2) return null;
    for (const value of Object.values(obj)) {
        if (isArn(value)) return value.trim();
    }
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const found = scanForArn(value, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

// The resource's ARN: explicit `arn` field, an ARN-shaped `id`, or the first ARN found in
// `details`. Null when the resource carries none (e.g. a design sketch or an S3 bucket the
// agent reported by name only).
export function findArn(resource) {
    if (!resource || typeof resource !== 'object') return null;
    if (isArn(resource.arn)) return resource.arn.trim();
    if (isArn(resource.id)) return resource.id.trim();
    return scanForArn(resource.details);
}

// Middle-ellipsis for long ARNs in tight UI (tooltip): keep the service head and the
// resource tail, elide the account/middle.
export function shortArn(arn, max = 44) {
    if (typeof arn !== 'string' || arn.length <= max) return arn;
    const head = Math.ceil((max - 1) * 0.45);
    const tail = max - 1 - head;
    return `${arn.slice(0, head)}…${arn.slice(-tail)}`;
}

// Region: the explicit field wins, else the 4th ARN segment (arn:aws:svc:REGION:acct:…).
function regionOf(resource, arn) {
    if (resource?.region && typeof resource.region === 'string') return resource.region.trim();
    if (arn) {
        const region = arn.split(':')[3];
        if (region) return region;
    }
    return null;
}

// Resource name/id for URL paths: prefer the plain id; if the id IS the ARN, fall back to the
// last ARN path segment (arn:…:function/foo → foo, arn:…:table/Bar → Bar).
function plainId(resource, arn) {
    const id = typeof resource?.id === 'string' ? resource.id.trim() : '';
    if (id && !isArn(id)) return id;
    if (arn) {
        const tail = arn.split(':').pop() || '';
        return tail.split('/').pop() || null;
    }
    return null;
}

function regionHost(region) {
    return region ? `https://${region}.console.aws.amazon.com` : 'https://console.aws.amazon.com';
}

// Per-service console deep links. Keys are the normalized `type` aliases (same normalization
// as ResourceDetail's serviceLabel). Each builder gets (host, region, id, arn) and returns a
// URL or null when it can't (e.g. missing region for a region-scoped console page).
const CONSOLE_BUILDERS = {
    ec2: (h, r, id) => (r && id ? `${h}/ec2/home?region=${r}#InstanceDetails:instanceId=${id}` : null),
    s3: (_h, r, id) => (id ? `https://s3.console.aws.amazon.com/s3/buckets/${id}${r ? `?region=${r}` : ''}` : null),
    lambda: (h, r, id) => (r && id ? `${h}/lambda/home?region=${r}#/functions/${id}` : null),
    rds: (h, r, id) => (r && id ? `${h}/rds/home?region=${r}#database:id=${id}` : null),
    aurora: (h, r, id) => (r && id ? `${h}/rds/home?region=${r}#database:id=${id}` : null),
    dynamodb: (h, r, id) => (r && id ? `${h}/dynamodbv2/home?region=${r}#table?name=${id}` : null),
    sqs: (h, r, _id, arn) => (r && arn ? `${h}/sqs/v3/home?region=${r}#/queues` : null),
    sns: (h, r, _id, arn) => (r && arn ? `${h}/sns/v3/home?region=${r}#/topic/${encodeURIComponent(arn)}` : null),
    vpc: (h, r, id) => (r && id ? `${h}/vpcconsole/home?region=${r}#VpcDetails:VpcId=${id}` : null),
    subnet: (h, r, id) => (r && id ? `${h}/vpcconsole/home?region=${r}#SubnetDetails:subnetId=${id}` : null),
    ecs: (h, r, id) => (r && id ? `${h}/ecs/v2/clusters/${id}?region=${r}` : null),
    eks: (h, r, id) => (r && id ? `${h}/eks/home?region=${r}#/clusters/${id}` : null),
    cloudfront: (_h, _r, id) => (id ? `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${id}` : null),
    elb: (h, r) => (r ? `${h}/ec2/home?region=${r}#LoadBalancers:` : null),
    alb: (h, r) => (r ? `${h}/ec2/home?region=${r}#LoadBalancers:` : null),
    nlb: (h, r) => (r ? `${h}/ec2/home?region=${r}#LoadBalancers:` : null),
    'api-gateway': (h, r, id) => (r && id ? `${h}/apigateway/home?region=${r}#/apis/${id}` : null),
    apigateway: (h, r, id) => (r && id ? `${h}/apigateway/home?region=${r}#/apis/${id}` : null),
    iam: (_h, _r, id) => (id ? `https://console.aws.amazon.com/iam/home#/roles/details/${id}` : null),
    cognito: (h, r, id) => (r && id ? `${h}/cognito/v2/idp/user-pools/${id}/users?region=${r}` : null),
    route53: (_h, _r, id) => (id ? `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${id}` : null),
    elasticache: (h, r) => (r ? `${h}/elasticache/home?region=${r}#/` : null),
    kinesis: (h, r, id) => (r && id ? `${h}/kinesis/home?region=${r}#/streams/details/${id}` : null),
    'step-functions': (h, r, _id, arn) => (r && arn ? `${h}/states/home?region=${r}#/statemachines/view/${encodeURIComponent(arn)}` : null),
    'secrets-manager': (h, r, id) => (r && id ? `${h}/secretsmanager/home?region=${r}#!/secret?name=${encodeURIComponent(id)}` : null)
};

// Same type normalization as ResourceDetail's serviceLabel — keep in lockstep.
function normalizeType(type) {
    return String(type || '')
        .toLowerCase()
        .replace(/^aws[_-]/, '')
        .replace(/[_-](service|function|table|bucket|queue|topic|cluster|instance)$/, '');
}

// Deep link to this resource in the AWS console, or null when there isn't enough identity to
// build one. Falls back to AWS's official ARN resolver (console.aws.amazon.com/go/view) for
// any service without a dedicated builder.
export function consoleUrl(resource) {
    if (!resource || typeof resource !== 'object') return null;
    const arn = findArn(resource);
    const region = regionOf(resource, arn);
    const id = plainId(resource, arn);
    // const builder = CONSOLE_BUILDERS[normalizeType(resource.type)];
    const builder = CONSOLE_BUILDERS[resource.name];
    if (builder) {
        const url = builder(regionHost(region), region, id, arn);
        if (url) return url;
    }
    if (arn) return `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn)}`;
    return null;
}
