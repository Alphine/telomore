// Pure helpers for the G×E Study page, split into their own module so the
// page component only exports the component (React Fast Refresh / oxlint
// convention -- see biologicalAgeUtils.ts/subclonesUtils.ts for the same
// split).
//
// docs/ROADMAP.md 2026-09-13 follow-up to Genome Stability. The disclaimer
// below MUST accompany any reranking result everywhere it is rendered
// (docs/SCIENTIFIC_SCOPE.md "Language policy") -- exported as one constant
// so every call site (and its Vitest assertion) uses the exact same wording.
import type { GxECell } from '../api/types'

export const GXE_DISCLAIMER =
  "'Genotype' is a named parameter-override bundle and 'environment' is a stress_level override, not real " +
  "genetic or ecological variation; re-ranking is a property of this model's own fitness output, not a " +
  'validated biological finding.'

/** Environment names in first-seen order (the order the config listed them, preserved through the flat cell list). */
export function environmentOrder(cells: GxECell[]): string[] {
  return [...new Set(cells.map((c) => c.environment))]
}
