// A themed range slider: a native <input type="range"> (accessible + keyboard-friendly for free)
// with an optional value readout on the right and optional end captions under the track (e.g.
// "Slow"/"Fast"). Sibling to Segment.jsx — used by the Sigil Options panel for line thickness and
// animation speed, where a continuous value reads better than three fixed buttons.
export default function Slider({
    label, min, max, step = 1, value, onChange, disabled = false,
    readout = null, minLabel = null, maxLabel = null
}) {
    return (
        <div className={`ca-slider ${disabled ? 'is-disabled' : ''}`}>
            <div className="ca-slider-row">
                <input
                    type="range"
                    className="ca-slider-input"
                    aria-label={label}
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(Number(e.target.value))}
                />
                {readout != null && <span className="ca-slider-readout">{readout}</span>}
            </div>
            {(minLabel || maxLabel) && (
                <div className="ca-slider-ends" aria-hidden="true">
                    <span>{minLabel}</span>
                    <span>{maxLabel}</span>
                </div>
            )}
        </div>
    );
}
