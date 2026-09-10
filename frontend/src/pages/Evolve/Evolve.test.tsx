import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvolveJob, GenerationRecord } from '../../api/types'
import { resetBoundsCache } from '../../api/useBounds'
import { BOUNDS } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { FITNESS_FORMULA, parseSeeds } from './form'
import { Evolve } from './index'

vi.mock('../../components/charts/Plot', () => ({
  Plot: ({ figure }: { figure: { layout: { title?: { text?: string } } } }) => (
    <div data-testid="plot">{figure.layout.title?.text}</div>
  ),
}))

// Poll fast in tests.
vi.mock('../../api/useJob', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/useJob')>()
  return {
    ...mod,
    useJob: (jobId: string | null) => mod.useJob(jobId, { intervalMs: 10 }),
  }
})

beforeEach(() => {
  resetBoundsCache()
  window.sessionStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

function record(generation: number): GenerationRecord {
  return {
    generation,
    best_fitness: 0.5 + 0.01 * generation,
    mean_fitness: 0.3,
    median_fitness: 0.31,
    diversity: 0.2,
    best_genome: { stress_level: 0.3, maintenance_rate: 0.25, repair_rate: 0.4 },
    best_breakdown: {},
    n_invalid: 0,
    evaluations_so_far: 8 * (generation + 1),
    elapsed_seconds: 1.5 * (generation + 1),
  }
}

function jobSnapshot(status: EvolveJob['status'], extra: Partial<EvolveJob> = {}): EvolveJob {
  return {
    job_id: 'job-1',
    kind: 'evolve',
    status,
    progress: null,
    result: null,
    error: null,
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

describe('parseSeeds', () => {
  it('parses comma-separated ints and rejects non-integers', () => {
    expect(parseSeeds('1, 2,3,')).toEqual([1, 2, 3])
    expect(parseSeeds('')).toEqual([])
    expect(parseSeeds('1,x')).toBeNull()
  })
})

describe('Evolve page', () => {
  it('renders the fitness formula and optimizer defaults from /api/meta/bounds', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Evolve />, { route: '/evolve', token: 'jwt' })
    expect(await screen.findByText(FITNESS_FORMULA)).toBeInTheDocument()
    expect((screen.getByLabelText('Candidates per generation') as HTMLInputElement).value).toBe('32')
    expect((screen.getByLabelText('Generations') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText(/Simulator seeds/) as HTMLInputElement).value).toBe('1,2,3')
    expect(screen.getByLabelText('stress_level')).toBeChecked()
    expect(screen.getByLabelText('initial_length')).not.toBeChecked()
    expect(screen.getByText(/Baseline \(fixed genes come from here\)/)).toHaveTextContent('stress 0.60')
  })

  it('starts a job, shows Stop + live progress while running, then the completed result', async () => {
    let polls = 0
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/evolve': { status: 200, body: { job_id: 'job-1' } },
      'GET /api/jobs/job-1': () => {
        polls += 1
        if (polls < 3) return { status: 200, body: jobSnapshot('running', { progress: record(polls) }) }
        return {
          status: 200,
          body: jobSnapshot('completed', {
            progress: record(3),
            result: {
              run_id: 'TEL-20260909-007',
              best: { genome: record(3).best_genome, fitness: 0.53, breakdown: null, terminal_metrics: {} },
              baseline: {
                genome: { stress_level: 0.6, maintenance_rate: 0.1, repair_rate: 0.15 },
                fitness: 0.2,
                breakdown: null,
                terminal_metrics: {},
              },
              history: [record(0), record(1), record(2), record(3)],
              evaluations: 32,
              runtime_seconds: 6,
              stopped_early: false,
              stop_reason: '',
            },
          }),
        }
      },
    })
    renderApp(<Evolve />, { route: '/evolve', token: 'jwt' })
    await screen.findByText(FITNESS_FORMULA)

    fireEvent.change(screen.getByLabelText('Generations'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Evolve/ }))

    // Running: Stop is offered and the progress text reflects the latest GenerationRecord.
    expect(await screen.findByRole('button', { name: /Stop/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Generation \d\/3 · best \+0\.5/))
    expect(screen.getByRole('button', { name: /Evolve/ })).toBeDisabled()

    // Completed: Stop disappears, result metrics + ledger id + three charts.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument())
    expect(await screen.findByText('TEL-20260909-007')).toBeInTheDocument()
    expect(screen.getByText('+0.530')).toBeInTheDocument()
    expect(screen.getByText('+0.330')).toBeInTheDocument() // delta vs baseline
    const titles = screen.getAllByTestId('plot').map((el) => el.textContent)
    expect(titles).toEqual(
      expect.arrayContaining([
        'Fitness by generation',
        'Population diversity (mean gene SD, normalised)',
        "Best candidate's parameters (normalised to gene bounds)",
      ]),
    )

    const start = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/evolve') && init?.method === 'POST')
    const body = JSON.parse(String((start![1] as RequestInit).body))
    expect(body.evolution).toMatchObject({ generations: 3, eval_seeds: [1, 2, 3], free_genes: ['stress_level', 'maintenance_rate', 'repair_rate'] })
    expect(body.evolution.weights).toEqual(BOUNDS.fitness_weights_default)
    expect(body.model.stress_level).toBe(0.6)
  })

  it('Stop posts to /stop and a failed job shows its error', async () => {
    let stopped = false
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/evolve': { status: 200, body: { job_id: 'job-1' } },
      'GET /api/jobs/job-1': () => ({
        status: 200,
        body: stopped ? jobSnapshot('failed', { error: 'boom' }) : jobSnapshot('running', { progress: record(1) }),
      }),
      'POST /api/jobs/job-1/stop': () => {
        stopped = true
        return { status: 200, body: jobSnapshot('running', { progress: record(1) }) }
      },
    })
    renderApp(<Evolve />, { route: '/evolve', token: 'jwt' })
    await screen.findByText(FITNESS_FORMULA)
    fireEvent.click(screen.getByRole('button', { name: /Evolve/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Stop/ }))
    expect(await screen.findByText(/The optimization job failed: boom/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })

  it('sends schedule_phases and renders @-phase gene rows plus the best protocol table', async () => {
    const genome = { 'maintenance_rate@0': 0.9, 'maintenance_rate@1': 0.4, 'maintenance_rate@2': 0.2, repair_rate: 0.5 }
    const baseGenome = { 'maintenance_rate@0': 0.1, 'maintenance_rate@1': 0.1, 'maintenance_rate@2': 0.1, repair_rate: 0.15 }
    const rec: GenerationRecord = { ...record(0), best_genome: genome }
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/evolve': { status: 200, body: { job_id: 'job-1' } },
      'GET /api/jobs/job-1': {
        status: 200,
        body: jobSnapshot('completed', {
          progress: rec,
          result: {
            run_id: 'TEL-20260910-020',
            best: { genome, fitness: 0.53, breakdown: null, terminal_metrics: {} },
            baseline: { genome: baseGenome, fitness: 0.2, breakdown: null, terminal_metrics: {} },
            history: [rec],
            evaluations: 8,
            runtime_seconds: 1,
            stopped_early: false,
            stop_reason: '',
          },
        }),
      },
    })
    renderApp(<Evolve />, { route: '/evolve', token: 'jwt' })
    await screen.findByText(FITNESS_FORMULA)
    expect((screen.getByLabelText(/Protocol phases/) as HTMLInputElement).value).toBe('1')
    expect(screen.getByText(/did not beat a constant dose/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Protocol phases/), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Evolve/ }))

    await screen.findByText('TEL-20260910-020')
    const start = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/evolve') && init?.method === 'POST')
    const body = JSON.parse(String((start![1] as RequestInit).body))
    expect(body.evolution.schedule_phases).toBe(3)

    // Gene table: phase genes grouped by parameter, in phase order, then the constant gene.
    const genes = Array.from(document.querySelectorAll('tr[data-gene]')).map((tr) => tr.getAttribute('data-gene'))
    expect(genes).toEqual(['maintenance_rate@0', 'maintenance_rate@1', 'maintenance_rate@2', 'repair_rate'])
    expect(screen.getAllByText('phase 2').length).toBeGreaterThan(0)

    // Best protocol table (3 phases + time average) and step plot, from the best genome's schedule.
    const table = screen.getByTestId('protocol-table')
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent))
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual(['0', '0–39', '0.900'])
    expect(rows[3]).toEqual(['time average', '0.500'])
    expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Best candidate protocol (per-cycle values)')

    // The Compare hand-off carries the assembled schedule, not raw `@` keys.
    const handoff = JSON.parse(window.sessionStorage.getItem('tel_evolve_best')!)
    expect(handoff.config.schedule).toEqual({ phases: 3, values: { maintenance_rate: [0.9, 0.4, 0.2] } })
    expect(handoff.config.maintenance_rate).toBe(0.9)
    expect(handoff.config.repair_rate).toBe(0.5)
    expect(Object.keys(handoff.config).some((k) => k.includes('@'))).toBe(false)
  })

  it('rejects non-integer seeds client-side', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<Evolve />, { route: '/evolve', token: 'jwt' })
    await screen.findByText(FITNESS_FORMULA)
    fireEvent.change(screen.getByLabelText(/Simulator seeds/), { target: { value: '1,abc' } })
    fireEvent.click(screen.getByRole('button', { name: /Evolve/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Seeds must be integers.')
  })
})
