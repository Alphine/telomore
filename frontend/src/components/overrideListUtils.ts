// Pure helpers for a generic "named parameter-override bundle" row list --
// the shape shared by GenotypeSpec and EnvironmentSpec in a G×E study
// (docs/ROADMAP.md 2026-09-13 follow-up). Structurally the non-fraction half
// of subclonesUtils.ts: no initial_fraction, no sum-to-1 constraint, since
// genotypes/environments are evaluated in isolated simulations, never as
// competing sub-populations. Kept in its own module (no component export
// here) so oxlint's react/only-export-components never fires, same
// convention as subclonesUtils.ts/scheduleUtils.ts.

export interface OverrideRow {
  name: string
  overrides: Record<string, number>
}

/** A default single-row starting point (no overrides) for "add the first row". */
export function defaultRows<T extends OverrideRow>(prefix: string): T[] {
  return [{ name: `${prefix} A`, overrides: {} }] as T[]
}

/** Append a new, auto-lettered row with no overrides. */
export function addRow<T extends OverrideRow>(rows: T[], prefix: string): T[] {
  return [...rows, { name: `${prefix} ${String.fromCharCode(65 + rows.length)}`, overrides: {} } as T]
}

/** Remove a row by index. */
export function removeRow<T extends OverrideRow>(rows: T[], index: number): T[] {
  return rows.filter((_, i) => i !== index)
}

export function updateRow<T extends OverrideRow>(rows: T[], index: number, patch: Partial<T>): T[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r))
}

export function setOverride<T extends OverrideRow>(rows: T[], index: number, key: string, value: number | null): T[] {
  return rows.map((r, i) => {
    if (i !== index) return r
    const overrides = { ...r.overrides }
    if (value === null) delete overrides[key]
    else overrides[key] = value
    return { ...r, overrides }
  })
}
