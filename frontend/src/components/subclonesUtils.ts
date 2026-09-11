// Pure helpers for sub-clone competition (docs/MODEL.md §2.2). Kept in its
// own module (no component export here) so oxlint's react/only-export-components
// never fires for this file -- the lesson from ScheduleEditor/scheduleUtils.
import type { ModelConfig, SubcloneSpec } from '../api/types'

export const SUBCLONE_FRACTION_TOLERANCE = 1e-6

/** True when the config carries >= 1 sub-clone (a single clone is invalid; validated separately). */
export function hasSubclones(config: Pick<ModelConfig, 'subclones'>): config is ModelConfig & { subclones: SubcloneSpec[] } {
  return Boolean(config.subclones && config.subclones.length > 0)
}

/** Sum of every clone's initial_fraction. */
export function fractionSum(clones: SubcloneSpec[]): number {
  return clones.reduce((total, c) => total + (Number.isFinite(c.initial_fraction) ? c.initial_fraction : 0), 0)
}

/** Whether the fractions sum to ~1.0 within the same tolerance the core uses. */
export function fractionsAreValid(clones: SubcloneSpec[]): boolean {
  return Math.abs(fractionSum(clones) - 1.0) <= SUBCLONE_FRACTION_TOLERANCE
}

/** A default two-clone starting point (50/50, no overrides) for "enable competition". */
export function defaultClones(): SubcloneSpec[] {
  return [
    { name: 'clone A', initial_fraction: 0.5, overrides: {} },
    { name: 'clone B', initial_fraction: 0.5, overrides: {} },
  ]
}

/** Attach/replace `subclones` on a config, or drop the key when the list is empty/undefined. */
export function withSubclones(config: ModelConfig, clones: SubcloneSpec[] | null): ModelConfig {
  const { subclones: _old, ...rest } = config
  const next = rest as ModelConfig
  if (clones && clones.length) next.subclones = clones
  return next
}

/** Request payload: omit `subclones` entirely when the toggle is off / list is empty. */
export function subclonesPayload(config: ModelConfig, enabled: boolean): ModelConfig {
  return enabled ? withSubclones(config, config.subclones ?? null) : withSubclones(config, null)
}

/** Add a new, unnamed clone row with an even split recomputed across all rows. */
export function addClone(clones: SubcloneSpec[]): SubcloneSpec[] {
  const next = [...clones, { name: `clone ${String.fromCharCode(65 + clones.length)}`, initial_fraction: 0, overrides: {} }]
  const even = 1 / next.length
  return next.map((c) => ({ ...c, initial_fraction: even }))
}

/** Remove a clone row by index; the remaining rows are NOT auto-rebalanced (the user may want to fix fractions by hand). */
export function removeClone(clones: SubcloneSpec[], index: number): SubcloneSpec[] {
  return clones.filter((_, i) => i !== index)
}

export function updateClone(clones: SubcloneSpec[], index: number, patch: Partial<SubcloneSpec>): SubcloneSpec[] {
  return clones.map((c, i) => (i === index ? { ...c, ...patch } : c))
}

export function setOverride(clones: SubcloneSpec[], index: number, key: string, value: number | null): SubcloneSpec[] {
  return clones.map((c, i) => {
    if (i !== index) return c
    const overrides = { ...c.overrides }
    if (value === null) delete overrides[key]
    else overrides[key] = value
    return { ...c, overrides }
  })
}

/**
 * Final-composition readout: the last non-null value of each clone's
 * `clone_fraction` array (the arrays are `cycles + 1` long; an extinct
 * population's trailing entries are still finite, never NaN -- see
 * `simulator/model.py::_clone_fractions`).
 */
export function finalComposition(cloneFraction: Record<string, number[]>): Array<{ name: string; fraction: number }> {
  return Object.entries(cloneFraction).map(([name, arr]) => ({ name, fraction: arr.length ? arr[arr.length - 1] : 0 }))
}
