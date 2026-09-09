/** st.multiselect over a fixed option list, rendered as checkboxes that keep the options' order. */
export function CheckboxGroup({
  legend,
  help,
  options,
  value,
  onChange,
  disabled,
  render,
}: {
  legend: string
  help?: string
  options: string[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  /** Optional label renderer (default: the option name in monospace). */
  render?: (option: string) => React.ReactNode
}) {
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      {help && <p className="prose-muted mb-2 text-xs">{help}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((o) => (
          <label key={o} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="accent-teal-600"
              checked={value.includes(o)}
              disabled={disabled}
              onChange={(e) =>
                onChange(e.target.checked ? options.filter((x) => x === o || value.includes(x)) : value.filter((x) => x !== o))
              }
            />
            {render ? render(o) : <code className="font-mono text-xs">{o}</code>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
