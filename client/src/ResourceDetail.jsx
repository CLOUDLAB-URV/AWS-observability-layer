import { useEffect, useRef, useState } from 'react';
import { findArn, consoleUrl } from './awsLinks.js';
import { isExternalResource } from './externalResource.js';

// Slide-in panel showing the full live detail of one deployed resource, opened by clicking a
// service node in the diagram. The diagram node itself only carries the service kind (e.g.
// "Lambda"); everything identifying and specific about the resource is surfaced here instead —
// read straight from the resource record the backend keeps in state.json (id/arn/region/state/
// connections/details), so this panel is where "all the detail" lives. When the resource is
// deployed it really exists in AWS, so the ARN gets a copy button and a console deep link.

// Fields we promote to the Identity section, in display order.
const TOP_FIELDS = [
    ['id', 'ID'],
    ['arn', 'ARN'],
    ['name', 'Name'],
    ['region', 'Region'],
    ['state', 'State'],
    ['vpc', 'VPC'],
    ['subnet', 'Subnet']
];

// Top-level keys already rendered elsewhere (header/badges/identity/sections/deployment), so
// the generic "Attributes" catch-all skips them and shows only whatever extra fields a
// resource carries.
const HANDLED = new Set([
    ...TOP_FIELDS.map(([k]) => k),
    'type', 'connections', 'details', 'code', 'deployed', 'deploy_note', 'purpose', 'consoleUrl',
    'scope', 'attachments'
]);

// Nicely cased service name for the header, from the raw inventory `type`. Falls back to a
// humanized version of the type so unknown services still read cleanly.
const SERVICE_LABELS = {
    s3: 'S3', rds: 'RDS', sqs: 'SQS', sns: 'SNS', ec2: 'EC2', ecs: 'ECS', eks: 'EKS',
    elb: 'Load Balancer', alb: 'Application Load Balancer', nlb: 'Network Load Balancer',
    'api-gateway': 'API Gateway', apigateway: 'API Gateway', dynamodb: 'DynamoDB',
    cloudfront: 'CloudFront', vpc: 'VPC', subnet: 'Subnet', iam: 'IAM', kms: 'KMS', waf: 'WAF',
    elasticache: 'ElastiCache', cloudwatch: 'CloudWatch', eventbridge: 'EventBridge',
    documentdb: 'DocumentDB', opensearch: 'OpenSearch', msk: 'MSK', mq: 'MQ',
    fargate: 'Fargate', lambda: 'Lambda', kinesis: 'Kinesis', glue: 'Glue', athena: 'Athena',
    redshift: 'Redshift', aurora: 'Aurora', cognito: 'Cognito', route53: 'Route 53',
    'step-functions': 'Step Functions', 'secrets-manager': 'Secrets Manager',
    // Attachment kinds — without these, humanize() would render "Iam Role" and "Vpc".
    'iam-role': 'IAM role', 'iam-policy': 'IAM policy', 'security-group': 'Security group',
    'launch-template': 'Launch template', 'target-group': 'Target group', 'log-group': 'Log group',
    'key-pair': 'Key pair', 'instance-profile': 'Instance profile',
    'subnet-group': 'Subnet group', 'parameter-group': 'Parameter group',
    'ec2-auto-scaling': 'Auto Scaling group', 'auto-scaling': 'Auto Scaling group', asg: 'Auto Scaling group',
    // Network path primitives — drawn as nodes, so their panel header needs a proper name.
    'internet-gateway': 'Internet gateway', 'nat-gateway': 'NAT gateway',
    'vpc-endpoint': 'VPC endpoint', 'vpc-peering': 'VPC peering connection',
    'virtual-private-gateway': 'Virtual private gateway', 'customer-gateway': 'Customer gateway'
};

// The fields of an attachment shown as rows when it is expanded, in display order. `type`, `name`
// and `purpose` are already in its header, and `details` gets its own nested block below.
const ATTACHMENT_FIELDS = [['id', 'ID'], ['arn', 'ARN'], ['region', 'Region']];

function humanize(key) {
    return String(key)
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function serviceLabel(type) {
    if (!type) return 'Resource';
    const norm = String(type).toLowerCase().replace(/^aws[_-]/, '').replace(/[_-](service|function|table|bucket|queue|topic|cluster|instance)$/,'');
    return SERVICE_LABELS[norm] || humanize(norm);
}

// One key/value pair, rendered recursively: scalars inline, arrays of scalars joined, nested
// objects as an indented block, arrays of objects / deep structures as pretty JSON.
function KVRow({ label, value, onOpen }) {
    if (value == null || value === '') {
        return (
            <div className="rd-kv-row">
                <span className="rd-kv-key">{label}</span>
                <span className="rd-kv-val">—</span>
            </div>
        );
    }
    if (Array.isArray(value)) {
        const allScalar = value.every((v) => v == null || typeof v !== 'object');
        if (allScalar) {
            return (
                <div className="rd-kv-row">
                    <span className="rd-kv-key">{label}</span>
                    <span className="rd-kv-val">{value.length ? value.join(', ') : '—'}</span>
                </div>
            );
        }
        return (
            <div className="rd-kv-block">
                <span className="rd-kv-key">{label}</span>
                <pre className="rd-json">{JSON.stringify(value, null, 2)}</pre>
            </div>
        );
    }
    if (typeof value === 'object') {
        return (
            <div className="rd-kv-block">
                <span className="rd-kv-key">{label}</span>
                <div className="rd-kv-nested">
                    {Object.entries(value).map(([k, v]) => (
                        <KVRow key={k} label={humanize(k)} value={v} />
                    ))}
                </div>
            </div>
        );
    }
    // `onOpen` is only passed for values that name another resource (a parent VPC or subnet), and
    // only when that resource actually exists in the inventory — so the row is a plain value
    // whenever there is nothing to navigate to.
    if (onOpen) {
        return (
            <div className="rd-kv-row">
                <span className="rd-kv-key">{label}</span>
                <button type="button" className="rd-kv-val rd-kv-link" onClick={onOpen}>
                    {String(value)}
                </button>
            </div>
        );
    }
    return (
        <div className="rd-kv-row">
            <span className="rd-kv-key">{label}</span>
            <span className="rd-kv-val">{String(value)}</span>
        </div>
    );
}

// One supporting piece of a resource (its IAM role, security group, launch template…), collapsed to
// a single row until the user opens it. It is deliberately NOT a tab or a link out: the whole point
// is that these live inside the service they belong to, so expanding keeps the reader where they are.
function AttachmentRow({ item, open, onToggle }) {
    const rows = ATTACHMENT_FIELDS.filter(([key]) => item[key] != null && item[key] !== '');
    const details = item.details && typeof item.details === 'object' ? item.details : null;
    return (
        <div className={`rd-att${open ? ' is-open' : ''}`}>
            <button type="button" className="rd-att-head" onClick={onToggle} aria-expanded={open}>
                <svg className="rd-att-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true">
                    <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className="rd-att-kind">{serviceLabel(item.type)}</span>
                <span className="rd-att-name">{item.name || item.id}</span>
            </button>
            {open && (
                <div className="rd-att-body">
                    {item.purpose && <p className="rd-att-purpose">{item.purpose}</p>}
                    {rows.map(([key, label]) => (
                        <KVRow key={key} label={label} value={item[key]} />
                    ))}
                    {details && Object.entries(details).map(([key, value]) => (
                        <KVRow key={key} label={humanize(key)} value={value} />
                    ))}
                    <a
                        className="rd-att-console"
                        href={consoleUrl(item)}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open in AWS Console →
                    </a>
                </div>
            )}
        </div>
    );
}

export default function ResourceDetail({ resource, onClose, onViewCode, onOpenResource }) {
    // Which attachments are expanded, by index — several can be open at once, and the set resets
    // when the panel binds to a different resource (see the effect below).
    const [openAttachments, setOpenAttachments] = useState(() => new Set());
    // "Copied" feedback for the ARN copy button (auto-clears).
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef(null);
    useEffect(() => () => clearTimeout(copiedTimer.current), []);
    // A plain click RETARGETS the open tab at another resource instead of remounting this component
    // (see DeployedState.retargetResourceTab), so without this the expanded indices would carry over
    // and open unrelated attachments on the resource the user just clicked.
    useEffect(() => setOpenAttachments(new Set()), [resource?.id]);

    if (!resource) return null;

    const connections = Array.isArray(resource.connections) ? resource.connections : [];
    const details = resource.details && typeof resource.details === 'object' ? resource.details : null;
    // The supporting pieces that belong to this resource and get no node of their own.
    const attachments = Array.isArray(resource.attachments) ? resource.attachments : [];
    // Source files this resource runs (Lambda handler, EC2 user-data, …). Each opens in the
    // dedicated Code window via onViewCode; keep only well-formed entries.
    const codeFiles = (Array.isArray(resource.code) ? resource.code : []).filter(
        (file) => file && typeof file === 'object' && file.name && typeof file.content === 'string'
    );
    // The backend backfills `deployed` on read, so it's always a boolean by the time it's here.
    const deployed = resource.deployed === true;
    // External actors (internet / end user / browser) live outside AWS: their Deployment section
    // shows a neutral status — never the amber "not deployed", never a console link.
    const external = isExternalResource(resource);
    // Deployed only: the resource exists in AWS — derive its ARN (explicit field, ARN-shaped id,
    // or from `details`). The derived ARN gets its own copyable row, so the plain-text `arn`
    // identity row drops out to avoid showing it twice.
    const liveArn = deployed && !external ? findArn(resource) : null;
    const identityRows = TOP_FIELDS.filter(
        ([key]) => resource[key] != null && resource[key] !== '' && !(liveArn && key === 'arn')
    );

    async function copyArn() {
        try {
            await navigator.clipboard.writeText(liveArn);
            setCopied(true);
            clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable — leave the text selectable */ }
    }
    const extraRows = Object.entries(resource).filter(
        ([key, value]) => !HANDLED.has(key) && value != null && value !== ''
    );

    return (
        <aside className="resource-detail" aria-label="Resource details">
            <header className="rd-header">
                <div className="rd-title">
                    <span className="rd-type">{serviceLabel(resource.type)}</span>
                    <span className="rd-name">{resource.name || resource.id || '—'}</span>
                </div>
                <button type="button" className="rd-close" onClick={onClose} aria-label="Close details">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                </button>
            </header>

            {(resource.region || resource.state || resource.type || resource.scope) && (
                <div className="rd-badges">
                    {/* A subnet's public/private scope leads the badges: it is the first thing asked
                        about a subnet, and it mirrors the green/blue the box uses on the diagram. */}
                    {resource.scope && (
                        <span className={`rd-badge rd-badge-scope rd-scope-${resource.scope}`}>{resource.scope}</span>
                    )}
                    {resource.state && <span className="rd-badge rd-badge-state">{resource.state}</span>}
                    {resource.region && <span className="rd-badge">{resource.region}</span>}
                    {resource.type && <span className="rd-badge rd-badge-type">{resource.type}</span>}
                </div>
            )}

            <div className="rd-body">
                {/* What this resource does in THIS architecture, as reported by the agent. It leads
                    the panel because it is the question a reader has before any identifier. */}
                {resource.purpose && <p className="rd-purpose">{resource.purpose}</p>}

                <section className="rd-section rd-deployment">
                    <h4 className="rd-section-title">Deployment</h4>
                    <div className={`rd-cloud-status ${external ? 'is-external' : deployed ? 'is-deployed' : 'is-undeployed'}`}>
                        <span className="rd-cloud-dot" aria-hidden="true" />
                        {external
                            ? 'External element — outside AWS (nothing to deploy)'
                            : deployed ? 'In the AWS cloud' : 'Not deployed to AWS'}
                    </div>
                    {resource.deploy_note && (
                        <p className="rd-deploy-note">{resource.deploy_note}</p>
                    )}
                    {deployed && !external && (
                        <a
                            className="btn btn-primary rd-console-link"
                            href={consoleUrl(resource)}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Open in AWS Console
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                <polyline points="15 3 21 3 21 9" />
                                <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                        </a>
                    )}
                </section>

                {(identityRows.length > 0 || liveArn) && (
                    <section className="rd-section">
                        <h4 className="rd-section-title">Identity</h4>
                        {liveArn && (
                            <div className="rd-kv-block rd-arn-block">
                                <span className="rd-kv-key">ARN</span>
                                <div className="rd-arn-row">
                                    <code className="rd-arn-value">{liveArn}</code>
                                    <button
                                        type="button"
                                        className="rd-arn-copy"
                                        onClick={copyArn}
                                        title="Copy ARN"
                                        aria-label="Copy ARN to clipboard"
                                    >
                                        {copied ? (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <path d="M20 6L9 17l-5-5" />
                                            </svg>
                                        ) : (
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <rect x="9" y="9" width="13" height="13" rx="2" />
                                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                            </svg>
                                        )}
                                        {copied ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                            </div>
                        )}
                        {identityRows.map(([key, label]) => (
                            // `vpc` and `subnet` name another resource in the same inventory, so when
                            // that resource is really there the row becomes a way into it — the same
                            // panel the user gets by clicking the box on the diagram.
                            key === 'vpc' || key === 'subnet' ? (
                                <KVRow
                                    key={key}
                                    label={label}
                                    value={resource[key]}
                                    onOpen={onOpenResource ? () => onOpenResource(resource[key]) : null}
                                />
                            ) : (
                                <KVRow key={key} label={label} value={resource[key]} />
                            )
                        ))}
                    </section>
                )}

                {extraRows.length > 0 && (
                    <section className="rd-section">
                        <h4 className="rd-section-title">Attributes</h4>
                        {extraRows.map(([key, value]) => (
                            <KVRow key={key} label={humanize(key)} value={value} />
                        ))}
                    </section>
                )}

                {connections.length > 0 && (
                    <section className="rd-section">
                        <h4 className="rd-section-title">Connections ({connections.length})</h4>
                        {connections.map((c, i) => (
                            <div key={i} className="rd-conn">
                                <span className="rd-conn-arrow">→</span>
                                <span className="rd-conn-to">{c.to || '?'}</span>
                                {(c.protocol || c.port || c.kind) && (
                                    <span className="rd-conn-proto">
                                        {[c.kind, [c.protocol, c.port].filter(Boolean).join(' :')]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </span>
                                )}
                            </div>
                        ))}
                    </section>
                )}

                {attachments.length > 0 && (
                    <section className="rd-section">
                        <h4 className="rd-section-title">Attached ({attachments.length})</h4>
                        {attachments.map((item, i) => (
                            <AttachmentRow
                                key={`${item.type}-${item.id}-${i}`}
                                item={item}
                                open={openAttachments.has(i)}
                                onToggle={() => setOpenAttachments((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(i)) next.delete(i); else next.add(i);
                                    return next;
                                })}
                            />
                        ))}
                    </section>
                )}

                {codeFiles.length > 0 && (
                    <section className="rd-section">
                        <h4 className="rd-section-title">Code ({codeFiles.length})</h4>
                        {codeFiles.map((file, i) => (
                            <div key={`${file.name}-${i}`} className="rd-code-row">
                                <span className="rd-code-file">
                                    <span className="rd-code-name">{file.name}</span>
                                    {file.language && <span className="rd-code-lang">{file.language}</span>}
                                </span>
                                <button
                                    type="button"
                                    className="rd-code-view"
                                    onClick={() => onViewCode?.(file)}
                                    title={`View ${file.name}`}
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <polyline points="16 18 22 12 16 6" />
                                        <polyline points="8 6 2 12 8 18" />
                                    </svg>
                                    View code
                                </button>
                            </div>
                        ))}
                    </section>
                )}

                {details && Object.keys(details).length > 0 && (
                    <section className="rd-section">
                        <h4 className="rd-section-title">Details</h4>
                        {Object.entries(details).map(([key, value]) => (
                            <KVRow key={key} label={humanize(key)} value={value} />
                        ))}
                    </section>
                )}
            </div>
        </aside>
    );
}
