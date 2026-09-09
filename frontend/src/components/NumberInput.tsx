import { useState } from 'react'

export interface NumberInputProps {
  id?: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

/**
 * Controlled numeric input that keeps a local text draft while focused, so
 * clearing the field or typing a partial number does not snap back to the
 * previous value. The draft is committed (clamped to min/max) on blur/Enter.
 */
export function NumberInput({ id, value, onChange, min, max, step, disabled, className, ...rest }: NumberInputProps) {
  // The draft only matters while focused (it is seeded from `value` on focus);
  // when blurred the prop value is shown directly, so no sync effect is needed.
  const [draft, setDraft] = useState<string>(String(value))
  const [focused, setFocused] = useState(false)

  function commit() {
    const n = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    let v = n
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    if (v !== value) onChange(v)
    setDraft(String(v))
  }

  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className={className ?? 'input'}
      value={focused ? draft : String(value)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onFocus={() => {
        setDraft(String(value))
        setFocused(true)
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        // Live-apply values that are already valid so sliders/charts follow typing.
        if (e.target.value.trim() !== '' && Number.isFinite(n)) {
          const inRange = (min === undefined || n >= min) && (max === undefined || n <= max)
          if (inRange) onChange(n)
        }
      }}
      onBlur={() => {
        commit()
        setFocused(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      aria-label={rest['aria-label']}
    />
  )
}
