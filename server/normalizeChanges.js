'use strict';

// Pure normalization of the incremental changes the MCP tool uploads, kept out of index.js
// so it can be unit-tested without booting the server.

// A resource's `code` (Lambda handler, EC2 user-data, etc.) is stored verbatim and shown
// in the web, but state.json is loaded whole and (compacted) fed to the LLM, so an unbounded
// paste would bloat storage and the token bill. Cap the content per file and the file count.
export const MAX_CODE_CHARS = 20000;
export const MAX_CODE_FILES = 12;

// A resource's `attachments` are the supporting pieces that only exist to serve it — its security
// group, the IAM role it assumes, an auto scaling group's launch template. They are deliberately NOT
// resources of their own: they get no node on the diagram, they are read inside their parent's
// panel. Capped like `code`, for the same reason (state.json is loaded whole and summarised into
// every prompt built from the inventory).
export const MAX_ATTACHMENTS = 12;

// A resource's `purpose` is one sentence describing its role; it is shown in the web and goes
// into every prompt built from the inventory, so it is capped like `deploy_note`.
export const MAX_PURPOSE_CHARS = 300;

// A subnet's `scope` says whether it routes to an Internet Gateway. It is the one network fact the
// diagram shows without being clicked (public subnets and private ones get different accents), so
// only these two words are accepted — anything else is dropped rather than drawn wrong.
export const SUBNET_SCOPES = ['public', 'private'];

// Coerce and cap the per-resource `code` array. Returns a trimmed array or undefined (so the
// caller can drop the key entirely when there is nothing usable).
export function normalizeCode(code) {
    if (!Array.isArray(code)) {
        return undefined;
    }
    const files = [];
    for (const entry of code) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const name = String(entry.name ?? '').trim().slice(0, 200);
        const content = typeof entry.content === 'string' ? entry.content.slice(0, MAX_CODE_CHARS) : '';
        if (!name || !content) {
            continue;
        }
        const file = { name, content };
        const language = String(entry.language ?? '').trim().slice(0, 40);
        if (language) {
            file.language = language;
        }
        files.push(file);
        if (files.length >= MAX_CODE_FILES) {
            break;
        }
    }
    return files.length ? files : undefined;
}

// Coerce and cap the per-resource `attachments` array. Mirrors normalizeCode: an entry needs the
// same identity a real change needs (a `type` and a stable `id`), the free text is trimmed and
// capped, and `details` is passed through untouched exactly like a resource's own `details` is.
// Returns a trimmed array or undefined (so the caller can drop the key entirely).
export function normalizeAttachments(attachments) {
    if (!Array.isArray(attachments)) {
        return undefined;
    }
    const out = [];
    for (const entry of attachments) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const type = String(entry.type ?? '').trim().slice(0, 60);
        const id = String(entry.id ?? '').trim().slice(0, 200);
        if (!type || !id) {
            continue;
        }
        const item = { type, id };
        for (const field of ['name', 'arn', 'region']) {
            const value = String(entry[field] ?? '').trim().slice(0, 200);
            if (value) {
                item[field] = value;
            }
        }
        // What this attachment does FOR ITS PARENT, collapsed to one line and capped like the
        // resource-level `purpose` it mirrors.
        const purpose = typeof entry.purpose === 'string' ? entry.purpose.replace(/\s+/g, ' ').trim() : '';
        if (purpose) {
            item.purpose = purpose.slice(0, MAX_PURPOSE_CHARS);
        }
        if (entry.details && typeof entry.details === 'object') {
            item.details = entry.details;
        }
        out.push(item);
        if (out.length >= MAX_ATTACHMENTS) {
            break;
        }
    }
    return out.length ? out : undefined;
}

// Normalize the incremental changes the MCP tool uploaded into the canonical shape
// the state-merge pipeline expects: `{ op, type, id, ...resourceFields }`. Each
// change must carry a `type` and a stable `id` (the key it merges under); `op`
// defaults to 'upsert'. Entries missing type+id, or with an unknown op, are dropped.
export function normalizeChanges(body) {
    if (!Array.isArray(body?.changes)) {
        return [];
    }
    return body.changes
        .map((change) => {
            if (!change || typeof change !== 'object') {
                return null;
            }
            const type = String(change.type ?? '').trim();
            const id = String(change.id ?? '').trim();
            if (!type || !id) {
                return null;
            }
            const op = change.op === 'delete' ? 'delete' : 'upsert';
            // Carry the whole detailed record through; only normalize the controls.
            const normalized = { ...change, op, type, id };
            // Per-resource deployment divergence: `deployed` must be a strict boolean (anything
            // else is dropped → inherits the sigil mode), `deploy_note` a short trimmed string.
            if (typeof change.deployed === 'boolean') {
                normalized.deployed = change.deployed;
            } else {
                delete normalized.deployed;
            }
            const note = typeof change.deploy_note === 'string' ? change.deploy_note.trim() : '';
            if (note) {
                normalized.deploy_note = note.slice(0, 300);
            } else {
                delete normalized.deploy_note;
            }
            // What the resource DOES in this architecture: one line, trimmed and capped. Collapsed
            // to a single line because it renders as a paragraph in the web and is fed to the
            // diagram model, where stray newlines would break the inventory block's shape.
            const purpose = typeof change.purpose === 'string' ? change.purpose.replace(/\s+/g, ' ').trim() : '';
            if (purpose) {
                normalized.purpose = purpose.slice(0, MAX_PURPOSE_CHARS);
            } else {
                delete normalized.purpose;
            }
            // Whether a subnet is public or private. Accepted only as one of the two known words;
            // when the agent omits it we fall back to `MapPublicIpOnLaunch`, the field AWS's own
            // DescribeSubnets returns, so an agent that just forwards the describe output still
            // gets the public/private split right for free.
            const rawScope = typeof change.scope === 'string' ? change.scope.trim().toLowerCase() : '';
            const derivedScope = type.toLowerCase() === 'subnet' && change.details?.MapPublicIpOnLaunch === true
                ? 'public'
                : '';
            const scope = SUBNET_SCOPES.includes(rawScope) ? rawScope : derivedScope;
            if (scope) {
                normalized.scope = scope;
            } else {
                delete normalized.scope;
            }
            // Containment: references to the id of a pushed `vpc`/`subnet` resource. These are
            // sticky downstream (see visualizerStore.applyChanges), so the two "empty" cases must
            // stay distinguishable and an EMPTY STRING is kept verbatim as a sentinel:
            //   key absent     → the push says nothing; the merge carries the stored value forward.
            //   key === ''     → the agent deliberately pulled the resource OUT of its container.
            // Anything that is not a string at all is treated as saying nothing.
            for (const field of ['vpc', 'subnet']) {
                if (typeof change[field] === 'string') {
                    normalized[field] = change[field].trim();
                } else {
                    delete normalized[field];
                }
            }
            // Source code the resource runs: capped and cleaned, or dropped if unusable.
            const code = normalizeCode(change.code);
            if (code) {
                normalized.code = code;
            } else {
                delete normalized.code;
            }
            // The supporting pieces that live INSIDE this resource (security group, IAM role,
            // launch template…) rather than getting their own node.
            const attachments = normalizeAttachments(change.attachments);
            if (attachments) {
                normalized.attachments = attachments;
            } else {
                delete normalized.attachments;
            }
            return normalized;
        })
        .filter(Boolean);
}
