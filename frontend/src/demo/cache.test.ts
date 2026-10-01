import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEMO_INDEX, demoScenario } from '../test/demoHelpers'
import { mockFetch } from '../test/helpers'
import { demoUrl, fetchDemoIndex, fetchDemoScenario, loadedScenarios, resetDemoCache, scenariosFor } from './cache'
import { jobResult, makeReplay, syntheticJob } from './replay'
import type { DemoScenario } from './types'

beforeEach(() => resetDemoCache())
afterEach(() => vi.unstubAllGlobals())

describe('demo cache fetching', () => {
  it('builds URLs under <BASE>/demo-cache and appends the content version to scenario files', async () => {
    expect(demoUrl('index.json')).toBe('/demo-cache/index.json')
    expect(demoUrl('/simulate/a.json')).toBe('/demo-cache/simulate/a.json')
    const fetchMock = mockFetch({ 'GET /demo-cache/simulate/alpha.json': { status: 200, body: demoScenario('alpha') } })
    await fetchDemoScenario(DEMO_INDEX.features.simulate[0])
    expect(String(fetchMock.mock.calls[0][0])).toContain('alpha.json?v=abcdef0123')
  })

  it('does not cache failures (a retry hits the network again) but memoises successes', async () => {
    mockFetch({})
    await expect(fetchDemoIndex()).rejects.toThrow(/404/)
    const ok = mockFetch({ 'GET /demo-cache/index.json': { status: 200, body: DEMO_INDEX } })
    await fetchDemoIndex()
    await fetchDemoIndex()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('looks features up by slug, tolerating - and _ spellings, and returns [] for unknown features', () => {
    const idx = { ...DEMO_INDEX, features: { active_learning: DEMO_INDEX.features.simulate } }
    expect(scenariosFor(idx, 'active-learning')).toHaveLength(2)
    expect(scenariosFor(idx, 'gxe')).toEqual([])
  })

  it('rejects a scenario file without a response', async () => {
    mockFetch({ 'GET /demo-cache/simulate/alpha.json': { status: 200, body: { id: 'alpha' } } })
    await expect(fetchDemoScenario(DEMO_INDEX.features.simulate[0])).rejects.toThrow(/malformed/)
  })
})

describe('demo replay', () => {
  const sc = (over: Partial<DemoScenario>): DemoScenario => ({ id: 's', title: 't', description: 'd', feature: 'x', request: null, response: null, ...over })

  it('unwraps a job snapshot to its result and builds a completed synthetic job', () => {
    expect(jobResult({ status: 'completed', result: { a: 1 } })).toEqual({ a: 1 })
    expect(jobResult({ a: 1 })).toEqual({ a: 1 })
    expect(syntheticJob('s', 'active-learning', { a: 1 })).toMatchObject({ job_id: 'demo:s', kind: 'active_learning', status: 'completed', result: { a: 1 } })
  })

  it('serves experiments from the ledger list and extra.details, refusing unknown runs', () => {
    const replay = makeReplay(() =>
      sc({ feature: 'experiments', response: [{ run_id: 'R1' }], extra: { details: { R1: { run_id: 'R1', config: {} } } } }),
    )
    expect(replay('GET', '/experiments?mine=true')).toEqual({ hit: true, value: [{ run_id: 'R1' }] })
    expect(replay('GET', '/experiments/R1')).toEqual({ hit: true, value: { run_id: 'R1', config: {} } })
    expect(replay('GET', '/experiments/R1/artifacts')).toEqual({ hit: true, value: [] })
    expect(replay('GET', '/experiments/R2')).toEqual({ hit: false })
  })

  it('replays only the precomputed genome mutations and finds the genome in any loaded scenario', () => {
    const genomeSc = sc({
      feature: 'genome',
      request: { mutations: [{ gene: 'G', position: 1, alt: 'A' }] },
      response: { genome: { genes: [] }, mutations: [{ effect: 'missense' }] },
    })
    loadedScenarios.set('s', genomeSc)
    const replay = makeReplay(() => genomeSc)
    expect(replay('GET', '/sequence/genome')).toEqual({ hit: true, value: { genes: [] } })
    expect(replay('POST', '/sequence/mutate', { gene: 'G', position: 1, alt: 'A' })).toEqual({ hit: true, value: { effect: 'missense' } })
    expect(replay('POST', '/sequence/mutate', { gene: 'G', position: 2, alt: 'A' })).toEqual({ hit: false })
    // a lineage scenario still finds the genome from the loaded toy-genome one
    const lineage = sc({ feature: 'genome', response: { model_bridge: {} } })
    expect(makeReplay(() => lineage)('GET', '/sequence/genome')).toEqual({ hit: true, value: { genes: [] } })
    expect(makeReplay(() => lineage)('POST', '/sequence/lineage')).toEqual({ hit: true, value: { model_bridge: {} } })
  })
})
