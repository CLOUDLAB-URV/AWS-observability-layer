// The Sigilum mark: a monochrome SVG recreation of the brand emblem (a circular seal
// enclosing a tilted tag with an eyelet and a pennant on a staff). Drawn with
// `currentColor`, so it inherits — and can be tinted by — the surrounding text color
// (white in the header, --brand on hover/accents, any color in emails or docs).
// Geometry traced from logo.jpeg, normalized to a 100×100 viewBox.
export default function Logo({ size = 22, className = '', title = 'Sigilum' }) {
    return (
        <svg
            viewBox="0 0 100 100"
            width={size}
            height={size}
            className={className}
            role="img"
            aria-label={title}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {/* outer seal */}
            <circle cx="50" cy="50" r="44" strokeWidth="4.5" />
            {/* tilted tag */}
            <path d="M15.5 45 L30 28.5 L63.5 56 L49 72.5 Z" />
            {/* tag eyelet */}
            <circle cx="30.5" cy="43" r="4.2" />
            {/* staff */}
            <path d="M45.5 78 L70.5 28.5" />
            {/* pommel */}
            <circle cx="71.7" cy="26.5" r="5" fill="currentColor" stroke="none" />
            {/* pennant hanging from the staff */}
            <path d="M71 33.5 L71 63.5 L57.5 55.5" />
            {/* small fold at the staff's foot */}
            <path d="M46.5 69.5 L44.5 78.5 L53 77.5 Z" />
        </svg>
    );
}
