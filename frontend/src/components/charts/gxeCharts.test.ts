import { describe, expect, it } from 'vitest'

import type { GxECell } from '../../api/types'
import { reactionNormChart } from './gxeCharts'

const CELLS: GxECell[] = [
  { genotype: 'A', environment: 'env1', fitness: 1.0, survival: 0.9, senescence: 0.1 },
  { genotype: 'A', environment: 'env2', fitness: 0.0, survival: 0.5, senescence: 0.5 },
  { genotype: 'B', environment: 'env1', fitness: 0.5, survival: 0.7, senescence: 0.3 },
  { genotype: 'B', environment: 'env2', fitness: 1.0, survival: 0.9, senescence: 0.1 },
]

describe('reaction norm chart', () => {
  it('builds one line trace per genotype, values placed by environment order', () => {
    const fig = reactionNormChart(CELLS, ['env1', 'env2'], false)
    expect(fig.data).toHaveLength(2)
    const [a, b] = fig.data as Array<{ name: string; x: string[]; y: Array<number | null> }>
    expect(a.name).toBe('A')
    expect(a.x).toEqual(['env1', 'env2'])
    expect(a.y).toEqual([1.0, 0.0])
    expect(b.name).toBe('B')
    expect(b.y).toEqual([0.5, 1.0])
  })

  it('uses a categorical x-axis and fills missing cells with null (not off-by-one)', () => {
    const cells: GxECell[] = [{ genotype: 'A', environment: 'env2', fitness: 0.3, survival: 0.3, senescence: 0.3 }]
    const fig = reactionNormChart(cells, ['env1', 'env2'], false)
    expect(fig.layout.xaxis).toMatchObject({ type: 'category' })
    const [a] = fig.data as Array<{ y: Array<number | null> }>
    expect(a.y).toEqual([null, 0.3])
  })
})
