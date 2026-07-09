import { useEffect, useRef, useState } from 'react';
import { findArn, consoleUrl } from './awsConsole.js';

// Slide-in panel showing the full live detail of one deployed resource, opened by clicking a
// service node in the diagram. The diagram node itself only carries the service kind (e.g.
// "Lambda"); everything identifying and specific about the resource is surfaced here instead —
// read straight from the resource record the backend keeps in state.json (id/arn/region/state/
// connections/details), so this panel is where "all the detail" lives. On Live sigils the
// resource really exists in AWS, so the ARN gets a copy button and a console deep link appears.

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

// Top-level keys already rendered elsewhere (header/badges/identity/sections), so the generic
// "Attributes" catch-all skips them and shows only whatever extra fields a resource carries.
const HANDLED = new Set([...TOP_FIELDS.map(([k]) => k), 'type', 'connections', 'details']);

// Nicely cased service name for the header, from the raw inventory `type`. Falls back to a
// humanized version of the type so unknown services still read cleanly.
const SERVICE_LABELS = {
    s3: 'S3', rds: 'RDS', sqs: 'SQS', sns: 'SNS', ec2: 'EC2', ecs: 'ECS', eks: 'EKS',
    elb: 'Load Balancer', alb: 'Application Load Balancer', nlb: 'Network Load Balancer',
    'api-gateway': 'API Gateway', apigateway: 'API Gateway', dynamodb: 'DynamoDB',
    cloudfront: 'CloudFront', vpc: 'VPC', iam: 'IAM', kms: 'KMS', waf: 'WAF',
    elasticache: 'ElastiCache', cloudwatch: 'CloudWatch', eventbridge: 'EventBridge',
    documentdb: 'DocumentDB', opensearch: 'OpenSearch', msk: 'MSK', mq: 'MQ',
    fargate: 'Fargate', lambda: 'Lambda', kinesis: 'Kinesis', glue: 'Glue', athena: 'Athena',
    redshift: 'Redshift', aurora: 'Aurora', cognito: 'Cognito', route53: 'Route 53',
    'step-functions': 'Step Functions', 'secrets-manager': 'Secrets Manager'
};

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
function KVRow({ label, value }) {
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
    return (
        <div className="rd-kv-row">
            <span className="rd-kv-key">{label}</span>
            <span className="rd-kv-val">{String(value)}</span>
        </div>
    );
}

export default function ResourceDetail({ resource, deployed = false, onClose }) {
    // "Copied" feedback for the ARN copy button (auto-clears).
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef(null);
    useEffect(() => () => clearTimeout(copiedTimer.current), []);

    if (!resource) return null;

    const connections = Array.isArray(resource.connections) ? resource.connections : [];
    const details = resource.details && typeof resource.details === 'object' ? resource.details : null;
    // Live only: the resource exists in AWS — derive its ARN (explicit field, ARN-shaped id, or
    // from `details`) and a console deep link. The derived ARN gets its own copyable row, so the
    // plain-text `arn` row drops out of the generic identity list to avoid showing it twice.
    const liveArn = deployed ? findArn(resource) : null;
    const liveUrl = deployed ? consoleUrl(resource) : null;
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
                <button type="button" className="rd-close" onClick={onClose} aria-label="Close details">✕</button>
            </header>

            {(resource.region || resource.state || resource.type) && (
                <div className="rd-badges">
                    {resource.state && <span className="rd-badge rd-badge-state">{resource.state}</span>}
                    {resource.region && <span className="rd-badge">{resource.region}</span>}
                    {resource.type && <span className="rd-badge rd-badge-type">{resource.type}</span>}
                </div>
            )}

            {liveUrl && (
                <a
                    className="rd-console-link"
                    href={liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this resource in the AWS console"
                >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <path d="M15 3h6v6" />
                        <path d="M10 14L21 3" />
                    </svg>
                    Open in AWS Console
                </a>
            )}

            <div className="rd-body">
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
                            <KVRow key={key} label={label} value={resource[key]} />
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
