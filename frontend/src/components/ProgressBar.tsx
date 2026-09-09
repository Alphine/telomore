/** st.progress(fraction, text=...) */
export function ProgressBar({ fraction, text }: { fraction: number; text: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className="h-full bg-teal-600 transition-all dark:bg-teal-400" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm">{text}</p>
    </div>
  )
}
