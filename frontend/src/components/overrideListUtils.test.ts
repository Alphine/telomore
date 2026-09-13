import { describe, expect, it } from 'vitest'

import type { OverrideRow } from './overrideListUtils'
import { addRow, defaultRows, removeRow, setOverride, updateRow } from './overrideListUtils'

interface Row extends OverrideRow {
  name: string
  overrides: Record<string, number>
}

describe('overrideListUtils', () => {
  it('defaultRows returns one unnamed row with no overrides', () => {
    const rows = defaultRows<Row>('genotype')
    expect(rows).toEqual([{ name: 'genotype A', overrides: {} }])
  })

  it('addRow appends an auto-lettered row', () => {
    const rows = addRow<Row>([{ name: 'genotype A', overrides: {} }], 'genotype')
    expect(rows).toEqual([{ name: 'genotype A', overrides: {} }, { name: 'genotype B', overrides: {} }])
  })

  it('removeRow drops by index without touching the rest', () => {
    const rows: Row[] = [{ name: 'A', overrides: {} }, { name: 'B', overrides: {} }, { name: 'C', overrides: {} }]
    expect(removeRow(rows, 1)).toEqual([{ name: 'A', overrides: {} }, { name: 'C', overrides: {} }])
  })

  it('updateRow patches only the targeted row', () => {
    const rows: Row[] = [{ name: 'A', overrides: {} }, { name: 'B', overrides: {} }]
    expect(updateRow(rows, 0, { name: 'renamed' })).toEqual([{ name: 'renamed', overrides: {} }, { name: 'B', overrides: {} }])
  })

  it('setOverride adds/removes an override key without touching others', () => {
    const rows: Row[] = [{ name: 'A', overrides: { stress_level: 0.5 } }]
    expect(setOverride(rows, 0, 'maintenance_rate', 0.3)[0].overrides).toEqual({ stress_level: 0.5, maintenance_rate: 0.3 })
    expect(setOverride(rows, 0, 'stress_level', null)[0].overrides).toEqual({})
  })
})
