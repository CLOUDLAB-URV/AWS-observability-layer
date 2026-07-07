// Date formatting for the admin panel. Kept local to admin/ — DeployedState.jsx has its own
// private formatDate; consolidating the two into a shared util is a future cleanup candidate.

// Absolute, human-readable: "Jun 1, 2026, 10:00" (used in tooltips and detail rows).
export function formatDate(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'never';
    return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

// Relative, compact: "just now" / "5m ago" / "3h ago" / "2d ago" / "Jun 1, 2026".
export function formatRelative(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'never';
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// True when the timestamp falls within the last `days` days (used for the "Active 7d" stat).
export function withinDays(iso, days) {
    if (!iso) return false;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return false;
    return Date.now() - d.getTime() < days * 24 * 60 * 60 * 1000;
}
