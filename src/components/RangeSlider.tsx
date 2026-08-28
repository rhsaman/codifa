import React from 'react'

interface RangeSliderProps {
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  ariaLabel?: string
}

/**
 * Custom slider. The native <input type=range> thumb is centered on the value
 * and, depending on the browser, either overflows the track ends or is
 * constrained inside it — which makes value 0 look like a small positive
 * value. Here the visible thumb is positioned with a percentage and
 * translateX(-50%), so 0% sits exactly on the left edge (label) and 100% on
 * the right edge, identically in every browser. The invisible native input
 * overlays it to keep drag/keyboard/focus behaviour.
 */
export function RangeSlider({ min, max, step, value, onChange, ariaLabel }: RangeSliderProps) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
  return (
    <div className="range-slider">
      <div className="range-track">
        <div className="range-fill" style={{ width: `${pct}%` }} />
        <div className="range-thumb" style={{ left: `${pct}%` }} />
      </div>
      <input
        type="range"
        className="range-input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
