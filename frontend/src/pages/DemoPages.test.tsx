// Feature pages in demo mode: the cached scenario fills the locked form and the
// existing result views render it, with no call to the live compute API.
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBoundsCache } from '../api/useBounds'
import { FeatureGate } from '../demo/FeatureGate'
import { resetDemoCache } from '../demo/cache'
import { BOUNDS, fakeRun } from '../test/fixtures'
import { mockFetch, renderApp } from '../test/helpers'
import { Sensitivity } from './Sensitivity'
import { Simulate } from './Simulate'

vi.mock('../components/charts/Plot', () => ({
  Plot: ({ figure }: { figure: { layout: { title?: { text?: string } } } }) => (
    <div data-testid="plot">{figure.layout.title?.text}</div>
  ),
}))

const idx = (feature: string, id: string) => ({
  version: 1,
  features: { [feature]: [{ id, title: `${id} example`, description: 'precomputed', file: `${feature}/${id}.json` }] },
})

beforeEach(() => {
  resetBoundsCache()
  resetDemoCache()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Simulate in demo mode', () => {
  it('shows the cached run, locks the form and never POSTs /api/simulate', async () => {
    const run = fakeRun()
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'GET /demo-cache/index.json': { status: 200, body: idx('simulate', 'one') },
      'GET /demo-cache/simulate/one.json': {
        status: 200,
        body: { id: 'one', title: 'one', description: 'd', feature: 'simulate', request: { config: run.config }, response: { run } },
      },
    })
    renderApp(
      <FeatureGate feature="simulate">
        <Simulate />
      </FeatureGate>,
    )
    expect(await screen.findByText('Precomputed example – not live compute')).toBeInTheDocument()
    expect(await screen.findByTestId('metric-row')).toBeInTheDocument()
    expect(screen.getAllByTestId('plot').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Run simulation/ })).toBeDisabled()
    expect(screen.getByLabelText('Stress level (a.u.)')).toBeDisabled()
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })
})

describe('Sensitivity (a job page) in demo mode', () => {
  it('replays the cached job result through the normal job view', async () => {
    const items = [
      { parameter: 'stress_level', baseline_value: 0.5, low_value: 0.4, high_value: 0.6, fitness_low: 0.5, fitness_baseline: 0.3, fitness_high: 0.1, swing: -0.4 },
      { parameter: 'repair_rate', baseline_value: 0.5, low_value: 0.4, high_value: 0.6, fitness_low: 0.28, fitness_baseline: 0.3, fitness_high: 0.32, swing: 0.04 },
    ]
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'GET /demo-cache/index.json': { status: 200, body: idx('sensitivity', 'oat') },
      'GET /demo-cache/sensitivity/oat.json': {
        status: 200,
        body: {
          id: 'oat',
          title: 'oat',
          description: 'd',
          feature: 'sensitivity',
          request: { model: {}, sensitivity: { parameters: ['stress_level', 'repair_rate'], perturbation_fraction: 0.2, eval_seeds: [4, 5] }, notes: '' },
          response: { run_id: 'DEMO-1', baseline_fitness: 0.3, items, evaluations: 10, runtime_seconds: 0 },
        },
      },
    })
    renderApp(
      <FeatureGate feature="sensitivity">
        <Sensitivity />
      </FeatureGate>,
    )
    const table = await screen.findByTestId('sensitivity-table')
    await waitFor(() => expect(table).toHaveTextContent('stress_level'))
    // the request filled the (locked) form
    expect((screen.getByLabelText(/Simulator seeds/) as HTMLInputElement).value).toBe('4, 5')
    expect(screen.getByLabelText(/Simulator seeds/)).toBeDisabled()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/jobs') || String(c[0]).endsWith('/api/sensitivity'))).toBe(false)
  })
})
