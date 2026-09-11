// Pure helpers for BiologicalAgeGauge, split into their own module so that
// component file only exports the component (keeps React Fast Refresh
// working, per this repo's lint convention -- see ScheduleEditor/
// scheduleUtils and SubcloneEditor/subclonesUtils for the same split).
//
// ROADMAP.md candidate feature #5 (synthetic "biological age" biomarker
// score). The mandatory caption below MUST accompany the score everywhere
// it is rendered (docs/SCIENTIFIC_SCOPE.md "Language policy") -- it is
// exported as one constant so every call site (and its Vitest assertion)
// uses the exact same wording.
export const BIOLOGICAL_AGE_DISCLAIMER =
  "A synthetic index computed from this simulation's own telomere reserve, senescence and survival numbers " +
  '— not a measurement of biological age, not medical information.'

/** Reference-band colour for a 0-100 synthetic age index value. */
export function ageBandColor(score: number): string {
  if (score < 33) return '#059669' // emerald-600 -- youthful reference
  if (score < 66) return '#d97706' // amber-600 -- intermediate
  return '#dc2626' // rose-600 -- senescent reference
}

/** Short human label for the same band, safe to render next to the number. */
export function ageBandLabel(score: number): string {
  if (score < 33) return 'youthful reference'
  if (score < 66) return 'intermediate'
  return 'senescent reference'
}

/** Clamp/guard a possibly-null score for display; null when not renderable. */
export function clampScore(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null
  return Math.min(100, Math.max(0, score))
}
