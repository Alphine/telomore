import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CompareResponse, ModelConfig } from '../../api/types'
import { resetBoundsCache } from '../../api/useBounds'
import { resetChipPresetsCache } from '../../api/useChipPresets'
import { saveBaseline } from '../../components/baseline'
import { saveCompareUserConfig, saveEvolveBest } from '../../components/handoff'
import { BOUNDS, CHIP_PRESETS, fakeRun } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { Compare } from './index'

vi.mock('../../components/charts/Plot', () => ({
  Plot: ({ figure }: { figure: { layout: { title?: { text?: string } } } }) => (
    <div data-testid="plot">{figure.layout.title?.text}</div>
  ),
}))

const CHIP_PRESETS_ROUTE = { 'GET /api/meta/chip-presets': { status: 200, body: CHIP_PRESETS } }

beforeEach(() => {
  resetBoundsCache()
  resetChipPresetsCache()
  window.sessionStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

function scenario(name: string, cfg: Partial<ModelConfig>, fitness: number, deltas: CompareResponse['scenarios'][number]['deltas']) {
  const { run_id: _r, fitness: _f, ...rest } = fakeRun()
  return {
    name,
    result: { ...rest, config: { ...rest.config, ...cfg } },
    fitness,
    breakdown: { total: fitness, survival: 0.9, reserve: 0.27, senescence: 0.12, instability: 0.2, cost: 0.02, genome_instability: 0, canalization: 1, valid: true, reason: null },
    deltas,
  }
}

describe('Compare page', () => {
  it('always offers the baseline, prompts for missing hand-offs and disables their checkboxes', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS }, ...CHIP_PRESETS_ROUTE })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    expect(await screen.findByText(/no Evolve result in this session yet/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Best evolved/)).toBeDisabled()
    expect(screen.getByLabelText(/From Pareto page/)).toBeDisabled()
    expect(screen.getByRole('button', { name: /Compare 1 scenario$/ })).toBeInTheDocument()
    expect(screen.getByText('Add a second scenario to see deltas.')).toBeInTheDocument()
  })

  it('posts the assembled scenarios (baseline + manual, common seed) and renders the deltas table', async () => {
    saveBaseline({ ...BOUNDS.demo, seed: 7 })
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': {
        status: 200,
        body: {
          baseline: 'Baseline',
          scenarios: [
            scenario('Baseline', { seed: 7 }, 0.4, null),
            scenario('Manual', { stress_level: 0.2, seed: 7 }, 0.55, {
              fitness_abs: 0.15,
              fitness_pct: 37.5,
              senescence_pp: -4.2,
              reserve_kb: 0.31,
              mean_length_kb: 0.42,
              survival_abs: 0.08,
            }),
          ],
        } satisfies CompareResponse,
      },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/no Evolve result in this session yet/)

    fireEvent.click(screen.getByLabelText(/Manual parameters/))
    const stress = await screen.findByLabelText('Stress level (a.u.)')
    fireEvent.change(stress, { target: { value: '0.2' } })
    expect(screen.getByRole('button', { name: /Compare 2 scenarios/ })).toBeInTheDocument()
    expect((screen.getByLabelText('Common seed') as HTMLInputElement).value).toBe('7')
    fireEvent.click(screen.getByRole('button', { name: /Compare 2 scenarios/ }))

    const table = await screen.findByTestId('deltas-table')
    const row = table.querySelector('tbody tr')!
    const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent)
    expect(cells).toEqual(['Manual', '+0.550', '+0.150', '+37.5', '-4.20', '+0.310', '+0.420', '+0.080'])
    expect(screen.getByTestId('params-table').querySelectorAll('tbody tr')).toHaveLength(2)
    const titles = screen.getAllByTestId('plot').map((el) => el.textContent)
    expect(titles).toEqual(
      expect.arrayContaining([
        'Mean telomere length (kb)',
        'Senescent fraction',
        'Living cells',
        'Manual: weighted fitness contributions (total +0.550)',
      ]),
    )

    const call = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/compare') && init?.method === 'POST')
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.seed).toBe(7)
    expect(body.scenarios.map((s: { name: string }) => s.name)).toEqual(['Baseline', 'Manual'])
    expect(body.scenarios[0].config.stress_level).toBe(0.6)
    expect(body.scenarios[1].config.stress_level).toBe(0.2)
  })

  it('shows the synthetic age index per scenario with its disclaimer (ROADMAP.md #5)', async () => {
    saveBaseline({ ...BOUNDS.demo, seed: 7 })
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': {
        status: 200,
        body: {
          baseline: 'Baseline',
          scenarios: [
            scenario('Baseline', { seed: 7 }, 0.4, null),
            scenario('Manual', { stress_level: 0.2, seed: 7 }, 0.55, {
              fitness_abs: 0.15,
              fitness_pct: 37.5,
              senescence_pp: -4.2,
              reserve_kb: 0.31,
              mean_length_kb: 0.42,
              survival_abs: 0.08,
            }),
          ],
        } satisfies CompareResponse,
      },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/no Evolve result in this session yet/)

    fireEvent.click(screen.getByLabelText(/Manual parameters/))
    await screen.findByLabelText('Stress level (a.u.)')
    fireEvent.click(screen.getByRole('button', { name: /Compare 2 scenarios/ }))

    const table = await screen.findByTestId('params-table')
    expect(table).toHaveTextContent('synthetic age index')
    expect(screen.getByTestId('age-Baseline')).toHaveTextContent(fakeRun().biological_age!.final_score!.toFixed(1))
    expect(screen.getByTestId('age-Manual')).toHaveTextContent(fakeRun().biological_age!.final_score!.toFixed(1))
    expect(screen.getByTestId('biological-age-disclaimer')).toHaveTextContent(
      'not a measurement of biological age, not medical information.',
    )
  })

  it('pre-selects the Evolve and Pareto hand-offs from sessionStorage and can drop the common seed', async () => {
    saveEvolveBest({ config: { ...BOUNDS.demo, stress_level: 0.31 }, label: 'Evolve run TEL-1 (fitness +0.700)', run_id: 'TEL-1' })
    saveCompareUserConfig({ config: { ...BOUNDS.demo, repair_rate: 0.9 }, label: 'Pareto front point #1', run_id: null })
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': { status: 200, body: { baseline: 'Baseline', scenarios: [scenario('Baseline', {}, 0.4, null)] } },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/Evolve run TEL-1/)
    expect(screen.getByLabelText(/Best evolved/)).toBeChecked()
    expect(screen.getByLabelText(/From Pareto page/)).toBeChecked()
    fireEvent.click(screen.getByLabelText(/Force identical simulator seed/))
    fireEvent.click(screen.getByRole('button', { name: /Compare 3 scenarios/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/compare'))).toBe(true))
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/compare'))
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.seed).toBeUndefined()
    expect(body.scenarios.map((s: { name: string }) => s.name)).toEqual(['Baseline', 'Best evolved', 'From Pareto page'])
    expect(body.scenarios[1].config.stress_level).toBe(0.31)
    expect(body.scenarios[2].config.repair_rate).toBe(0.9)
  })

  it('passes a scheduled hand-off through untouched and shows the protocol panel + mean-dose columns', async () => {
    const protocol = { phases: 2, values: { maintenance_rate: [0.8, 0.2] } }
    saveEvolveBest({ config: { ...BOUNDS.demo, maintenance_rate: 0.8, schedule: protocol }, label: 'Evolve run TEL-2', run_id: 'TEL-2' })
    const scheduled = scenario('Best evolved', { maintenance_rate: 0.8, schedule: protocol }, 0.5, {
      fitness_abs: 0.1,
      fitness_pct: 25,
      senescence_pp: -1,
      reserve_kb: 0.1,
      mean_length_kb: 0.1,
      survival_abs: 0.05,
    })
    // fakeRun has 4 cycles -> 2 phases of 2 cycles; applied_schedule is cycles + 1 long.
    scheduled.result.applied_schedule = { maintenance_rate: [0.8, 0.8, 0.2, 0.2, 0.2] }
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': { status: 200, body: { baseline: 'Baseline', scenarios: [scenario('Baseline', {}, 0.4, null), scheduled] } },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/Evolve run TEL-2/)
    expect(screen.getByText(/phase 0 of a 2-phase protocol: maintenance_rate/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Compare 2 scenarios/ }))

    const table = await screen.findByTestId('params-table')
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/compare'))
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.scenarios[1].config.schedule).toEqual(protocol)
    expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Applied protocols (scheduled scenarios)')
    const means = Array.from(table.querySelectorAll('[data-testid="mean-maintenance_rate"]')).map((td) => td.textContent)
    expect(means).toEqual(['0.100', '0.500']) // constant scenario: its scalar; protocol: mean of the applied steps
    expect(table).toHaveTextContent('2-phase protocol')
    expect(table).toHaveTextContent('†')
  })

  it('adds an organ-chip preset scenario with the {name, chip} payload shape and shows its derived readout', async () => {
    saveBaseline({ ...BOUNDS.demo, seed: 9 })
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': {
        status: 200,
        body: {
          baseline: 'Baseline',
          scenarios: [
            scenario('Baseline', { seed: 9 }, 0.4, null),
            scenario('Liver-chip-like (low flow, physioxia)', { stress_level: 0.55, repair_rate: 0.28, seed: 9 }, 0.3, {
              fitness_abs: -0.1,
              fitness_pct: -25,
              senescence_pp: 3,
              reserve_kb: -0.2,
              mean_length_kb: -0.3,
              survival_abs: -0.05,
            }),
          ],
        } satisfies CompareResponse,
      },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/no Evolve result in this session yet/)

    const picker = await screen.findByLabelText('Preset')
    fireEvent.change(picker, { target: { value: 'liver_chip_like' } })
    expect(await screen.findByText(/low-perfusion, low-oxygen-tension/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ Add scenario' }))

    const list = await screen.findByTestId('chip-scenario-list')
    expect(list).toHaveTextContent('Liver-chip-like (low flow, physioxia)')
    expect(list).toHaveTextContent('0.550') // derived stress_level readout
    expect(screen.getByRole('button', { name: /Compare 2 scenarios/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Compare 2 scenarios/ }))
    await screen.findByTestId('deltas-table')

    const call = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/compare') && init?.method === 'POST')
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.scenarios.map((s: { name: string }) => s.name)).toEqual(['Baseline', 'Liver-chip-like (low flow, physioxia)'])
    expect(body.scenarios[1].chip).toEqual(CHIP_PRESETS.presets.liver_chip_like.conditions)
    expect(body.scenarios[1].config).toBeUndefined()
    expect(body.base_config).toEqual({ ...BOUNDS.demo, seed: 9 })
  })

  it('supports multiple chip-preset scenarios alongside a manual scenario in one submit, and can remove one', async () => {
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': { status: 200, body: { baseline: 'Baseline', scenarios: [scenario('Baseline', {}, 0.4, null)] } },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/no Evolve result in this session yet/)

    const picker = await screen.findByLabelText('Preset')
    fireEvent.change(picker, { target: { value: 'liver_chip_like' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add scenario' }))
    fireEvent.change(picker, { target: { value: 'lung_chip_like' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add scenario' }))
    fireEvent.click(screen.getByLabelText(/Manual parameters/))

    expect(screen.getByRole('button', { name: /Compare 4 scenarios/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Remove Lung-chip-like \(high flow, high O2\)/ }))
    expect(screen.getByRole('button', { name: /Compare 3 scenarios/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Compare 3 scenarios/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/compare'))).toBe(true))
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/compare'))
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.scenarios.map((s: { name: string }) => s.name)).toEqual(['Baseline', 'Manual', 'Liver-chip-like (low flow, physioxia)'])
  })

  it('shows a 400 from the API', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      ...CHIP_PRESETS_ROUTE,
      'POST /api/compare': { status: 400, body: { detail: 'Baseline: stress_level=2.0 outside [0.0, 1.0]' } },
    })
    renderApp(<Compare />, { route: '/compare', token: 'jwt' })
    await screen.findByText(/no Evolve result in this session yet/)
    fireEvent.click(screen.getByRole('button', { name: /Compare 1 scenario/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid configuration: Baseline: stress_level=2.0')
  })
})
