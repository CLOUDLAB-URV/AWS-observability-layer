'use strict';

// Name-matching for resuming a previous sigil by name (used by load_sigil). Extracted
// into its own module so it is unit-testable without importing index.js (which connects
// the MCP server transport at import time).

// Normalize a free-text name: lowercase, non-alphanumerics → spaces, collapse whitespace.
export function normalizeName(raw) {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Resolve a free-text sigil name to a chat from `list_sigils` by proximity. The calling
// agent is expected to pick the semantically closest name (it sees the list); this maps
// that name back to a chat id robustly. Scoring, in order:
//   1. exact normalized match wins outright;
//   2. otherwise substring containment + token overlap (Jaccard) / coverage over threshold;
//   3. ties break toward the more recent chat (the list is already newest-first).
// Returns the best chat object, or null when nothing is close enough.
export function matchByName(query, chats) {
    const q = normalizeName(query);
    if (!q || !Array.isArray(chats) || chats.length === 0) {
        return null;
    }
    const qTokens = new Set(q.split(' ').filter(Boolean));
    let best = null;
    let bestScore = 0;
    // chats is newest-first; iterating in order means equal scores keep the earlier
    // (more recent) entry, so ties break toward recency.
    for (const chat of chats) {
        const name = normalizeName(chat.name);
        if (!name) {
            continue;
        }
        if (name === q) {
            return chat; // exact normalized match — done
        }
        const nameTokens = new Set(name.split(' ').filter(Boolean));
        const overlap = [...qTokens].filter((t) => nameTokens.has(t)).length;
        const union = new Set([...qTokens, ...nameTokens]).size;
        const jaccard = union ? overlap / union : 0;
        const contains = name.includes(q) || q.includes(name) ? 0.5 : 0;
        // Coverage: how much of the shorter side is shared. Lets a short, distinctive
        // query ("rds") match a longer name ("vpc with rds") without a single token
        // dominating the Jaccard ratio. Weighted below 1 so exact names still win.
        const coverage = overlap ? 0.6 * (overlap / Math.min(qTokens.size, nameTokens.size)) : 0;
        const score = Math.max(jaccard, contains, coverage);
        if (score > bestScore) {
            bestScore = score;
            best = chat;
        }
    }
    // Require a meaningful overlap so unrelated names resolve to "no match".
    return bestScore >= 0.34 ? best : null;
}
