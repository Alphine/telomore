import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParameterSensitivity, SensitivityJob } from '../../api/types'
import { resetBoundsCache } from '../../api/useBounds'
import { BOUNDS } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { Sensitivity } from './index'

vi.mock('../../components/charts/Plot', () => ({
  Plot: ({ figure }: { figure: { layout: { title?: { text?: string } } } }) => (
    <div data-testid="plot">{figure.layout.title?.text}</div>
  ),
}))

vi.mock('../../api/useJob', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/useJob')>()
  return { ...mod, useJob: (jobId: string | null) => mod.useJob(jobId, { intervalMs: 10 }) }
})

beforeEach(() => {
  resetBoundsCache()
  window.sessionStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

function item(parameter: string, swing: number): ParameterSensitivity {
  return {
    parameter,
    baseline_value: 0.5,
    low_value: 0.4,
    high_value: 0.6,
    fitness_low: 0.3 - swing / 2,
    fitness_baseline: 0.3,
    fitness_high: 0.3 + swing / 2,
    swing,
  }
}

function jobSnapshot(status: SensitivityJob['status'], extra: Partial<SensitivityJob> = {}): SensitivityJob {
  return {
    job_id: 'job-s',
    kind: 'sensitivity',
    status,
    progress: null,
    result: null,
    error: null,
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

const ITEMS = [item('stress_level', -0.2), item('maintenance_rate', 0.05), item('repair_rate', 0.1)]

describe('Sensitivity page', () => {
  it('renders the parameter checkboxes from bounds.evolvable with SensitivityConfig defaults, no Stop', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Sensitivity />, { route: '/sensitivity', token: 'jwt' })
    expect(await screen.findByText(/One-at-a-time \(OAT\) sensitivity/)).toBeInTheDocument()
    for (const p of BOUNDS.evolvable) expect(screen.getByLabelText(p)).toBeChecked()
    expect((screen.getByLabelText(/Simulator seeds/) as HTMLInputElement).value).toBe('1,2,3')
    expect(screen.getByLabelText(/Perturbation/)).toHaveValue('0.1')
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })

  it('fills a live table per finished parameter, then shows the tornado chart sorted by |swing|', async () => {
    let polls = 0
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/sensitivity': { status: 200, body: { job_id: 'job-s' } },
      'GET /api/jobs/job-s': () => {
        polls += 1
        if (polls <= 2) return { status: 200, body: jobSnapshot('running', { progress: ITEMS[polls - 1] }) }
        return {
          status: 200,
          body: jobSnapshot('completed', {
            progress: ITEMS[2],
            result: { run_id: 'TEL-20260910-010', baseline_fitness: 0.3, items: ITEMS, evaluations: 21, runtime_seconds: 3.2 },
          }),
        }
      },
    })
    renderApp(<Sensitivity />, { route: '/sensitivity', token: 'jwt' })
    await screen.findByText(/One-at-a-time \(OAT\) sensitivity/)
    fireEvent.click(screen.getByLabelText('initial_length'))
    fireEvent.click(screen.getByLabelText('shortening_rate'))
    fireEvent.click(screen.getByLabelText('senescence_threshold'))
    fireEvent.click(screen.getByRole('button', { name: /Run sensitivity analysis/ }))

    // Running: progress text names the parameter, the live table grows, no Stop button.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/(stress_level|maintenance_rate): swing [+-]0\.\d{4} \(\d\/3\)/))
    expect(screen.getByTestId('sensitivity-table').querySelectorAll('tbody tr').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run sensitivity analysis/ })).toBeDisabled()

    // Completed: tornado, table sorted by |swing| (stress 0.2 > repair 0.1 > maintenance 0.05), provenance.
    await waitFor(() => expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Fitness sensitivity (one-at-a-time perturbation)'))
    const rows = Array.from(screen.getByTestId('sensitivity-table').querySelectorAll('tbody tr')).map(
      (tr) => tr.querySelector('td')!.textContent,
    )
    expect(rows).toEqual(['stress_level', 'repair_rate', 'maintenance_rate'])
    expect(screen.getByTestId('provenance')).toHaveTextContent('TEL-20260910-010')
    expect(screen.getByText('+0.300')).toBeInTheDocument()

    const start = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/sensitivity') && init?.method === 'POST')
    const body = JSON.parse(String((start![1] as RequestInit).body))
    expect(body.sensitivity).toEqual({
      parameters: ['stress_level', 'maintenance_rate', 'repair_rate'],
      perturbation_fraction: 0.1,
      eval_seeds: [1, 2, 3],
      weights: BOUNDS.fitness_weights_default,
    })
  })

  it('shows the API 400 as an invalid-configuration error', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/sensitivity': { status: 400, body: { detail: 'perturbation_fraction must be in (0, 0.5]' } },
    })
    renderApp(<Sensitivity />, { route: '/sensitivity', token: 'jwt' })
    await screen.findByText(/One-at-a-time \(OAT\) sensitivity/)
    fireEvent.click(screen.getByRole('button', { name: /Run sensitivity analysis/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid configuration: perturbation_fraction')
  })
})
