// Small segmented control: a row of mutually-exclusive buttons. Shared by the Export modal
// (format/scale/background) and the Sigil Options "Diagram display" section (on/off toggles),
// so both use the exact same control rather than two near-identical copies.
export default function Segment({ label, options, value, onChange, disabledValues = [] }) {
    return (
        <div className="ca-segment" role="group" aria-label={label}>
            {options.map(([id, text]) => {
                const disabled = disabledValues.includes(id);
                return (
                    <button
                        key={id}
                        type="button"
                        className={`ca-segment-btn ${value === id ? 'is-active' : ''}`}
                        aria-pressed={value === id}
                        disabled={disabled}
                        onClick={() => onChange(id)}
                    >
                        {text}
                    </button>
                );
            })}
        </div>
    );
}
