import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MOCandidate, MOGenerationRecord, ParetoJob } from '../../api/types'
import { resetBoundsCache } from '../../api/useBounds'
import { COMPARE_USER_CONFIG_KEY } from '../../components/handoff'
import { BOUNDS } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { defaultColorGene } from './form'
import { Pareto } from './index'

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

function record(generation: number): MOGenerationRecord {
  return {
    generation,
    front_size: 3 + generation,
    hypervolume: 0.4 + 0.05 * generation,
    n_invalid: 0,
    objective_means: { survival: 0.5, cost: 0.2 },
    objective_best: { survival: 0.8, cost: 0.05 },
    evaluations_so_far: 12 * (generation + 1),
    elapsed_seconds: 2 * (generation + 1),
  }
}

function candidate(stress: number, survival: number, cost: number): MOCandidate {
  return {
    genome: { stress_level: stress, maintenance_rate: 0.3, repair_rate: 0.4 },
    objectives: { survival, cost },
    vector: [-survival, cost],
    scalar_fitness: survival - cost,
    valid: true,
    rank: 0,
    crowding: null,
    breakdown: null,
    terminal_metrics: {},
  }
}

function jobSnapshot(status: ParetoJob['status'], extra: Partial<ParetoJob> = {}): ParetoJob {
  return {
    job_id: 'job-p',
    kind: 'pareto',
    status,
    progress: null,
    result: null,
    error: null,
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

const FRONT = [candidate(0.2, 0.9, 0.3), candidate(0.5, 0.7, 0.1), candidate(0.8, 0.4, 0.02)]

describe('defaultColorGene', () => {
  it('picks the free gene that varies along the front and null when none does', () => {
    expect(defaultColorGene(FRONT, ['stress_level', 'maintenance_rate', 'repair_rate'])).toBe('stress_level')
    expect(defaultColorGene(FRONT, ['maintenance_rate'])).toBeNull()
  })
})

describe('Pareto page', () => {
  it('renders the objectives multiselect from /api/meta/bounds and the MultiObjectiveConfig defaults', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Pareto />, { route: '/pareto', token: 'jwt' })
    expect(await screen.findByText(/Why a second optimizer/)).toBeInTheDocument()
    for (const o of Object.keys(BOUNDS.objectives)) expect(screen.getByLabelText(new RegExp(`^${o} \\(`))).toBeInTheDocument()
    expect(screen.getByLabelText(/^survival \(/)).toBeChecked()
    expect(screen.getByLabelText(/^cost \(/)).toBeChecked()
    expect(screen.getByLabelText(/^senescence \(/)).not.toBeChecked()
    expect((screen.getByLabelText('Population (even)') as HTMLInputElement).value).toBe('40')
    expect((screen.getByLabelText('Generations') as HTMLInputElement).value).toBe('25')
    expect(screen.getByTestId('baseline-summary')).toHaveTextContent('stress 0.60')
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })

  it('shows Stop + a live hypervolume chart while running, then the front on completion', async () => {
    let polls = 0
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/pareto': { status: 200, body: { job_id: 'job-p' } },
      'GET /api/experiments/TEL-20260910-009': {
        status: 200,
        body: { record: { run_id: 'TEL-20260910-009', configuration_hash: 'deadbeef00', git_commit: 'abc1234' }, artifacts: {} },
      },
      'GET /api/jobs/job-p': () => {
        polls += 1
        if (polls < 3) return { status: 200, body: jobSnapshot('running', { progress: record(polls) }) }
        return {
          status: 200,
          body: jobSnapshot('completed', {
            progress: record(4),
            result: {
              run_id: 'TEL-20260910-009',
              front: FRONT,
              baseline: candidate(0.6, 0.5, 0.2),
              history: [record(0), record(1), record(2), record(3), record(4)],
              reference_point: [0, 1],
              evaluations: 60,
              runtime_seconds: 9,
              stopped_early: false,
            },
          }),
        }
      },
    })
    renderApp(<Pareto />, { route: '/pareto', token: 'jwt' })
    await screen.findByText(/Why a second optimizer/)
    fireEvent.change(screen.getByLabelText('Population (even)'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('Generations'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: /Run NSGA-II/ }))

    // Running: Stop (with its copy) and the live HV chart from progress records.
    expect(await screen.findByRole('button', { name: /Stop/ })).toBeInTheDocument()
    expect(screen.getByText(/Stopping happens after the current generation finishes/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Generation \d\/4 · front \d+ · HV 0\.\d+/))
    expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Front quality by generation')
    expect(screen.getByRole('button', { name: /Run NSGA-II/ })).toBeDisabled()

    // Completed: front table, scatter, provenance with config hash, Stop gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument())
    const table = await screen.findByTestId('front-table')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(table).toHaveTextContent('scalar_fitness')
    expect(table).toHaveTextContent('stress_level')
    expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Pareto front (model outputs)')
    await waitFor(() => expect(screen.getByTestId('provenance')).toHaveTextContent('deadbeef00'))
    expect(screen.getByTestId('provenance')).toHaveTextContent('TEL-20260910-009')
    expect((screen.getByLabelText('Colour front by') as HTMLSelectElement).value).toBe('stress_level')

    const start = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/pareto') && init?.method === 'POST')
    const body = JSON.parse(String((start![1] as RequestInit).body))
    expect(body.multiobjective).toMatchObject({ population_size: 12, generations: 4, objectives: ['survival', 'cost'], eval_seeds: [42] })
    expect(body.multiobjective.weights).toEqual(BOUNDS.fitness_weights_default)
    expect(body.model.stress_level).toBe(0.6)
  })

  it('"Send this point" stores the merged config for the Compare page', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/pareto': { status: 200, body: { job_id: 'job-p' } },
      'GET /api/jobs/job-p': {
        status: 200,
        body: jobSnapshot('completed', {
          result: {
            run_id: null,
            front: FRONT,
            baseline: candidate(0.6, 0.5, 0.2),
            history: [record(0)],
            reference_point: [0, 1],
            evaluations: 12,
            runtime_seconds: 1,
            stopped_early: false,
          },
        }),
      },
    })
    renderApp(<Pareto />, { route: '/pareto', token: 'jwt' })
    await screen.findByText(/Why a second optimizer/)
    fireEvent.click(screen.getByRole('button', { name: /Run NSGA-II/ }))
    await screen.findByTestId('front-table')
    fireEvent.change(screen.getByLabelText(/Row of the front table/), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /Send this point/ }))
    const stored = JSON.parse(window.sessionStorage.getItem(COMPARE_USER_CONFIG_KEY)!)
    // Row 2 of the front sorted by survival (max): the lowest-survival candidate.
    expect(stored.config).toMatchObject({ stress_level: 0.8, maintenance_rate: 0.3, repair_rate: 0.4, seed: 42, cycles: 120 })
    expect(screen.getByRole('status')).toHaveTextContent('Sent.')
  })

  it('rejects fewer than two objectives client-side', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Pareto />, { route: '/pareto', token: 'jwt' })
    await screen.findByText(/Why a second optimizer/)
    fireEvent.click(screen.getByLabelText(/^cost \(/))
    fireEvent.click(screen.getByRole('button', { name: /Run NSGA-II/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Select at least two objectives.')
  })
})
