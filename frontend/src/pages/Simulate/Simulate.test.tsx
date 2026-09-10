import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBoundsCache } from '../../api/useBounds'
import { BOUNDS, fakeRun } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { Simulate } from './index'

// plotly.js needs a real browser; the chart wrapper is stubbed.
vi.mock('../../components/charts/Plot', () => ({
  Plot: ({ figure }: { figure: { layout: { title?: { text?: string } } } }) => (
    <div data-testid="plot">{figure.layout.title?.text}</div>
  ),
}))

beforeEach(() => {
  resetBoundsCache()
  window.sessionStorage.clear()
  // jsdom has no canvas implementation; the component falls back gracefully.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Simulate page', () => {
  it('renders the parameter form from GET /api/meta/bounds (labels, ranges, demo defaults)', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })

    const stress = (await screen.findByLabelText('Stress level (a.u.)')) as HTMLInputElement
    expect(stress.value).toBe('0.6') // configs/demo.yaml baseline, not ModelConfig() default
    const stressSlider = screen.getByLabelText('Stress level slider') as HTMLInputElement
    expect(stressSlider.min).toBe('0')
    expect(stressSlider.max).toBe('1')
    expect(stressSlider.step).toBe('0.01')

    const initial = screen.getByLabelText('Initial telomere length (kb)') as HTMLInputElement
    expect(initial.value).toBe('7.5')
    const initialSlider = screen.getByLabelText('Initial telomere length slider') as HTMLInputElement
    expect(initialSlider.min).toBe('3')
    expect(initialSlider.max).toBe('15')

    expect(screen.getByText(/press/)).toHaveTextContent('Run simulation')
    expect(screen.queryByTestId('metric-row')).not.toBeInTheDocument()
  })

  it('applies chip-derived values read-only when the organ-on-chip mapper is enabled', async () => {
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/meta/chip-to-params': { status: 200, body: { stress_level: 0.371, repair_rate: 0.44, cycles: 60 } },
    })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })
    await screen.findByLabelText('Stress level (a.u.)')

    fireEvent.click(screen.getByLabelText('Derive stress/repair from organ-on-chip conditions'))
    expect(await screen.findByText('Derived simulation parameters')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('chip-derived')).toHaveTextContent('0.371'))

    const stress = screen.getByLabelText('Stress level (a.u.)') as HTMLInputElement
    expect(stress.value).toBe('0.371')
    expect(stress).toBeDisabled()
    const cycles = screen.getByLabelText('Cycles') as HTMLInputElement
    expect(cycles.value).toBe('60')
    expect(cycles).toBeDisabled()
    expect(screen.getAllByText('derived from chip').length).toBe(3)

    const chipCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/meta/chip-to-params'))
    expect(chipCall).toBeTruthy()
    const body = JSON.parse(String((chipCall![1] as RequestInit).body))
    expect(body).toMatchObject({ flow_rate: 0.5, oxygen_tension: 0.21, culture_days: 60 })
  })

  it('runs a simulation and shows metrics, ledger id, particle canvas and the four charts', async () => {
    const run = fakeRun()
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/simulate': { status: 200, body: { run } },
    })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })
    await screen.findByLabelText('Stress level (a.u.)')

    fireEvent.click(screen.getByRole('button', { name: /Run simulation/ }))
    expect(await screen.findByTestId('metric-row')).toBeInTheDocument()
    expect(screen.getByText('6.50 kb')).toBeInTheDocument()
    expect(screen.getByText('not reached')).toBeInTheDocument()
    expect(screen.getByText('+0.512')).toBeInTheDocument()
    expect(screen.getByText('TEL-20260909-001')).toBeInTheDocument()
    expect(screen.getByLabelText('Population visualization')).toBeInTheDocument()

    const titles = screen.getAllByTestId('plot').map((el) => el.textContent)
    expect(titles).toEqual(
      expect.arrayContaining([
        'Telomere length over time',
        'Telomere length distribution',
        'Senescence over time',
        'Population over time',
      ]),
    )

    const simCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/simulate'))
    const body = JSON.parse(String((simCall![1] as RequestInit).body))
    expect(body.config.stress_level).toBe(0.6)
  })

  it('shows the API error on a 400', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/simulate': { status: 400, body: { detail: 'senescence_threshold=-1.0 outside [500.0, 6000.0]' } },
    })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })
    await screen.findByLabelText('Stress level (a.u.)')
    fireEvent.click(screen.getByRole('button', { name: /Run simulation/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid configuration: senescence_threshold=-1.0')
  })

  it('"Set as baseline" stores the config for the Evolve page', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })
    await screen.findByLabelText('Stress level (a.u.)')
    fireEvent.click(screen.getByRole('button', { name: 'Set as baseline' }))
    expect(JSON.parse(window.sessionStorage.getItem('tel_baseline_config')!)).toMatchObject({ stress_level: 0.6 })
    expect(screen.getByRole('status')).toHaveTextContent('Baseline updated for Evolve.')
  })

  it('omits `schedule` from the request when nothing is scheduled', async () => {
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/simulate': { status: 200, body: { run: fakeRun() } },
    })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })
    await screen.findByLabelText('Stress level (a.u.)')
    expect(screen.getByLabelText('Vary stress_level over time')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /Run simulation/ }))
    await screen.findByTestId('metric-row')
    const simCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/simulate'))
    const body = JSON.parse(String((simCall![1] as RequestInit).body))
    expect('schedule' in body.config).toBe(false)
    expect(screen.queryByTestId('protocol-table')).not.toBeInTheDocument()
  })

  it('loads the fasting demo preset, posts its schedule verbatim and renders the applied protocol', async () => {
    const preset = BOUNDS.presets.demo_fasting
    const run = fakeRun(12)
    run.config = { ...preset, cycles: 12 }
    // 12 cycles / 6 phases -> 2-cycle blocks; the API returns cycles + 1 values.
    run.applied_schedule = { stress_level: [0.9, 0.9, 0.3, 0.3, 0.9, 0.9, 0.3, 0.3, 0.9, 0.9, 0.3, 0.3, 0.3] }
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/simulate': { status: 200, body: { run } },
    })
    renderApp(<Simulate />, { route: '/simulate', token: 'jwt' })
    await screen.findByLabelText('Stress level (a.u.)')

    fireEvent.click(screen.getByRole('button', { name: 'Load fasting demo' }))
    expect(screen.getByRole('status')).toHaveTextContent('Loaded the "demo_fasting" protocol')
    expect(screen.getByLabelText('Vary stress_level over time')).toBeChecked()
    expect((screen.getByLabelText(/Phases \(1–8\)/) as HTMLInputElement).value).toBe('6')
    expect((screen.getByLabelText('stress_level phase 1') as HTMLInputElement).value).toBe('0.3')
    // The scalar slider is read-only while scheduled and shows the phase-0 value.
    const stress = screen.getByLabelText('Stress level (a.u.)') as HTMLInputElement
    expect(stress.value).toBe('0.9')
    expect(stress).toBeDisabled()
    expect(screen.getByText('scheduled')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Run simulation/ }))
    await screen.findByTestId('metric-row')
    const simCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/simulate'))
    const body = JSON.parse(String((simCall![1] as RequestInit).body))
    expect(body.config.schedule).toEqual(preset.schedule)
    expect(body.config.stress_level).toBe(0.9)

    // Applied-protocol step chart + phase table with the time average from applied_schedule.
    expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Applied protocol')
    const table = screen.getByTestId('protocol-table')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(7) // 6 phases + time average
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent))
    expect(rows[0]).toEqual(['0', '0–1', '0.900'])
    expect(rows[1]).toEqual(['1', '2–3', '0.300'])
    expect(rows[6]).toEqual(['time average', '0.600'])

    // Reset to constant drops the schedule again.
    fireEvent.click(screen.getByRole('button', { name: 'Reset to constant' }))
    expect(screen.getByLabelText('Vary stress_level over time')).not.toBeChecked()
    expect(screen.getByLabelText('Stress level (a.u.)')).not.toBeDisabled()
  })
})
