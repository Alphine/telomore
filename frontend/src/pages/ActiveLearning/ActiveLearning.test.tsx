import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveLearningJob, ActiveLearningRecord } from '../../api/types'
import { resetBoundsCache } from '../../api/useBounds'
import { BOUNDS } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { ActiveLearning } from './index'

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

function rec(iteration: number, phase: 'initial' | 'active', fitness: number, best: number): ActiveLearningRecord {
  return {
    iteration,
    phase,
    genome: { stress_level: 0.1 * iteration, maintenance_rate: 0.3, repair_rate: 0.4 },
    real_fitness: fitness,
    predicted_mean: phase === 'active' ? fitness - 0.01 : null,
    predicted_std: phase === 'active' ? 0.02 : null,
    acquisition_value: phase === 'active' ? 0.003 : null,
    best_so_far: best,
    n_real_evaluations: (iteration + 1) * 2,
  }
}

const RECORDS = [rec(0, 'initial', 0.2, 0.2), rec(1, 'initial', 0.35, 0.35), rec(2, 'active', 0.5, 0.5), rec(3, 'active', 0.45, 0.5)]

function jobSnapshot(status: ActiveLearningJob['status'], extra: Partial<ActiveLearningJob> = {}): ActiveLearningJob {
  return {
    job_id: 'job-a',
    kind: 'active_learning',
    status,
    progress: null,
    result: null,
    error: null,
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

describe('Active Learning page', () => {
  it('renders the ActiveLearningConfig controls with dataclass defaults and no Stop', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<ActiveLearning />, { route: '/active-learning', token: 'jwt' })
    expect(await screen.findByText(/Surrogate-model active learning/)).toBeInTheDocument()
    expect((screen.getByLabelText('Initial random design size') as HTMLInputElement).value).toBe('8')
    expect((screen.getByLabelText('Active-learning iterations') as HTMLInputElement).value).toBe('16')
    expect((screen.getByLabelText(/Expected Improvement margin/) as HTMLInputElement).value).toBe('0.01')
    expect((screen.getByLabelText('Optimizer random seed') as HTMLInputElement).value).toBe('11')
    expect(screen.getByLabelText('stress_level')).toBeChecked()
    expect(screen.getByLabelText('initial_length')).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })

  it('streams records into the live convergence chart + table, then shows the result', async () => {
    let polls = 0
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/active-learning': { status: 200, body: { job_id: 'job-a' } },
      'GET /api/jobs/job-a': () => {
        polls += 1
        if (polls <= 3) return { status: 200, body: jobSnapshot('running', { progress: RECORDS[polls - 1] }) }
        return {
          status: 200,
          body: jobSnapshot('completed', {
            progress: RECORDS[3],
            result: {
              run_id: 'TEL-20260910-011',
              best_genome: RECORDS[2].genome,
              best_fitness: 0.5,
              records: RECORDS,
              evaluations: 8,
              runtime_seconds: 4.4,
            },
          }),
        }
      },
    })
    renderApp(<ActiveLearning />, { route: '/active-learning', token: 'jwt' })
    await screen.findByText(/Surrogate-model active learning/)
    fireEvent.change(screen.getByLabelText('Initial random design size'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Active-learning iterations'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(/Simulator seeds/), { target: { value: '1,2' } })
    fireEvent.click(screen.getByRole('button', { name: /Run active learning/ }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/\[(initial|active)\] real fitness \+0\.\d{4} · best so far \+0\.\d{4} \(\d\/4\)/),
    )
    expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Optimizer convergence (real simulator evaluations)')
    expect(screen.getByTestId('iteration-table').querySelectorAll('tbody tr').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()

    await screen.findByText('Best fitness found')
    const table = screen.getByTestId('iteration-table')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(4)
    // predicted columns are empty during the initial design and filled in the active phase
    const cells = (row: number) => Array.from(table.querySelectorAll('tbody tr')[row].querySelectorAll('td')).map((td) => td.textContent)
    expect(cells(0)[1]).toBe('initial')
    expect(cells(0)[2]).toBe('')
    expect(cells(2)[1]).toBe('active')
    expect(cells(2)[2]).toBe('0.4900')
    expect(screen.getByTestId('provenance')).toHaveTextContent('TEL-20260910-011')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()

    const start = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/active-learning') && init?.method === 'POST')
    const body = JSON.parse(String((start![1] as RequestInit).body))
    expect(body.active_learning).toMatchObject({ n_initial: 2, n_iterations: 2, eval_seeds: [1, 2], seed: 11, xi: 0.01 })
    expect(body.model.stress_level).toBe(0.6)
  })

  it('a failed job shows its error', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/active-learning': { status: 200, body: { job_id: 'job-a' } },
      'GET /api/jobs/job-a': { status: 200, body: jobSnapshot('failed', { error: 'GP fit exploded' }) },
    })
    renderApp(<ActiveLearning />, { route: '/active-learning', token: 'jwt' })
    await screen.findByText(/Surrogate-model active learning/)
    fireEvent.click(screen.getByRole('button', { name: /Run active learning/ }))
    expect(await screen.findByText(/The active-learning job failed: GP fit exploded/)).toBeInTheDocument()
  })
})
