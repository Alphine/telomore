import { useTheme } from '../theme/context'
import type { ThemePreference } from '../theme/context'

// Plain emoji icons, matching this app's established icon convention (see
// features.ts, Layout.tsx's nav) rather than pulling in an icon library.
const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '🖥️' },
  { value: 'light', label: 'Light', icon: '☀️' },
  { value: 'dark', label: 'Dark', icon: '🌙' },
]

/**
 * Three-way theme toggle (system/light/dark). A `radiogroup` of plain
 * `<button>`s -- native buttons are keyboard-operable (Tab + Enter/Space)
 * without any bespoke widget, and `aria-checked` communicates which of the
 * three states is active to assistive tech.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme()
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={['inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700', className]
        .filter(Boolean)
        .join(' ')}
    >
      {OPTIONS.map((opt) => {
        const active = preference === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${opt.label} theme`}
            title={`${opt.label} theme`}
            onClick={() => setPreference(opt.value)}
            className={[
              'flex h-7 w-7 items-center justify-center rounded-md text-sm leading-none transition',
              active
                ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950'
                : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
            ].join(' ')}
          >
            <span aria-hidden>{opt.icon}</span>
          </button>
        )
      })}
    </div>
  )
}
