// Synthetic "biological age" score display (ROADMAP.md candidate feature
// #5). A big number + a simple CSS/SVG-free linear gauge -- no new chart
// library dependency for something this small. The disclaimer is rendered
// unconditionally in the SAME component instance as the score, so every
// place this gauge is mounted automatically carries it (docs/SCIENTIFIC_SCOPE.md).
import type { BiologicalAgeScore } from '../api/types'
import { BIOLOGICAL_AGE_DISCLAIMER, ageBandColor, ageBandLabel, clampScore } from './biologicalAgeUtils'

export function BiologicalAgeGauge({ score }: { score: BiologicalAgeScore | null | undefined }) {
  const value = score && score.valid ? clampScore(score.final_score) : null

  if (!score || value === null) {
    return (
      <div className="card p-5" data-testid="biological-age-gauge">
        <p className="prose-muted text-xs">Synthetic age index</p>
        <p className="prose-muted mt-1 text-sm">Unavailable for this run (the simulation was invalid).</p>
        <p className="prose-muted mt-3 text-xs" data-testid="biological-age-disclaimer">
          {BIOLOGICAL_AGE_DISCLAIMER}
        </p>
      </div>
    )
  }

  const color = ageBandColor(value)
  return (
    <div className="card p-5" data-testid="biological-age-gauge">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="prose-muted text-xs">Synthetic age index</p>
          <p className="font-heading text-3xl font-bold leading-tight" style={{ color }} data-testid="biological-age-value">
            {value.toFixed(1)}
            <span className="ml-1 text-base font-medium text-slate-400 dark:text-slate-500">/ 100</span>
          </p>
          <p className="text-xs font-medium" style={{ color }}>
            {ageBandLabel(value)}
          </p>
        </div>
        <div
          className="h-3 w-full max-w-40 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
          role="img"
          aria-label={`synthetic age index ${value.toFixed(1)} of 100, ${score.scale_label}`}
        >
          <div className="h-full rounded-full transition-[width]" style={{ width: `${value}%`, backgroundColor: color }} />
        </div>
      </div>
      <p className="prose-muted mt-3 text-xs" data-testid="biological-age-disclaimer">
        {BIOLOGICAL_AGE_DISCLAIMER}
      </p>
      <p className="prose-muted mt-1 text-[11px]">{score.formula_note}</p>
    </div>
  )
}
