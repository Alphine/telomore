import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GxECell, GxEJob } from '../../api/types'
import { resetBoundsCache } from '../../api/useBounds'
import { BOUNDS } from '../../test/fixtures'
import { mockFetch, renderApp } from '../../test/helpers'
import { GxE } from './index'

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

function cell(genotype: string, environment: string, fitness: number): GxECell {
  return { genotype, environment, fitness, survival: 0.5, senescence: 0.2 }
}

function jobSnapshot(status: GxEJob['status'], extra: Partial<GxEJob> = {}): GxEJob {
  return {
    job_id: 'job-g',
    kind: 'gxe',
    status,
    progress: null,
    result: null,
    error: null,
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

// A x env1 wins (1.0 > 0.5); B x env2 wins (1.0 > 0.0) -- a deliberate crossover.
const CROSSING_ITEMS = [
  cell('genotype A', 'environment 1', 1.0),
  cell('genotype A', 'environment 2', 0.0),
  cell('genotype B', 'environment 1', 0.5),
  cell('genotype B', 'environment 2', 1.0),
]

describe('G×E Study page', () => {
  it('renders two default genotype/environment rows and the seeds default, no Stop', async () => {
    mockFetch({ 'GET /api/meta/bounds': { status: 200, body: BOUNDS } })
    renderApp(<GxE />, { route: '/gxe', token: 'jwt' })
    expect(await screen.findByText(/Genotype × environment \(G×E\) study/)).toBeInTheDocument()
    expect(screen.getByTestId('genotype-editor').querySelectorAll('[data-testid^="gxe-genotype-row-"]')).toHaveLength(2)
    expect(screen.getByTestId('environment-editor').querySelectorAll('[data-testid^="gxe-environment-row-"]')).toHaveLength(2)
    expect((screen.getByLabelText(/Simulator seeds/) as HTMLInputElement).value).toBe('1,2,3')
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
  })

  it('fills a live table per finished cell, then shows the reaction-norm chart and the reranking callout', async () => {
    let polls = 0
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/gxe': { status: 200, body: { job_id: 'job-g' } },
      'GET /api/jobs/job-g': () => {
        polls += 1
        if (polls <= 3) return { status: 200, body: jobSnapshot('running', { progress: CROSSING_ITEMS[polls - 1] }) }
        return {
          status: 200,
          body: jobSnapshot('completed', {
            progress: CROSSING_ITEMS[3],
            result: {
              run_id: 'TEL-20260913-020',
              items: CROSSING_ITEMS,
              reranking_pairs: [['genotype A', 'genotype B']],
              evaluations: 12,
              runtime_seconds: 1.5,
            },
          }),
        }
      },
    })
    renderApp(<GxE />, { route: '/gxe', token: 'jwt' })
    await screen.findByText(/Genotype × environment \(G×E\) study/)
    fireEvent.click(screen.getByRole('button', { name: /Run G×E study/ }))

    // Running: progress names the cell, live table grows, no Stop button.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/genotype A x environment 1: fitness [+-]?\d\.\d{4} \(\d\/4\)/))
    expect(screen.getByTestId('gxe-table').querySelectorAll('tbody tr').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run G×E study/ })).toBeDisabled()

    // Completed: reaction-norm chart, reranking callout, table, provenance.
    await waitFor(() => expect(screen.getAllByTestId('plot').map((el) => el.textContent)).toContain('Reaction norms (genotype x environment)'))
    expect(screen.getByText('Genotype re-ranking detected')).toBeInTheDocument()
    expect(screen.getByText('Genotype re-ranking detected').closest('p')).toHaveTextContent('genotype A vs genotype B')
    expect(screen.getByTestId('gxe-disclaimer')).toBeInTheDocument()
    expect(screen.getByTestId('provenance')).toHaveTextContent('TEL-20260913-020')

    const start = fetchMock.mock.calls.find(([u, init]) => String(u).includes('/api/gxe') && init?.method === 'POST')
    const body = JSON.parse(String((start![1] as RequestInit).body))
    expect(body.gxe.eval_seeds).toEqual([1, 2, 3])
    expect(body.gxe.genotypes).toHaveLength(2)
    expect(body.gxe.environments).toHaveLength(2)
  })

  it('shows "no re-ranking" when reranking_pairs is empty', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/gxe': { status: 200, body: { job_id: 'job-g' } },
      'GET /api/jobs/job-g': {
        status: 200,
        body: jobSnapshot('completed', {
          result: {
            run_id: 'TEL-20260913-021',
            items: [cell('genotype A', 'environment 1', 1.0), cell('genotype B', 'environment 1', 0.5)],
            reranking_pairs: [],
            evaluations: 6,
            runtime_seconds: 0.5,
          },
        }),
      },
    })
    renderApp(<GxE />, { route: '/gxe', token: 'jwt' })
    await screen.findByText(/Genotype × environment \(G×E\) study/)
    fireEvent.click(screen.getByRole('button', { name: /Run G×E study/ }))
    expect(await screen.findByText(/No genotype re-ranking detected/)).toBeInTheDocument()
    expect(screen.getByTestId('gxe-disclaimer')).toBeInTheDocument()
  })

  it('shows the API 400 as an invalid-configuration error', async () => {
    mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'POST /api/gxe': { status: 400, body: { detail: 'genotype names must be unique' } },
    })
    renderApp(<GxE />, { route: '/gxe', token: 'jwt' })
    await screen.findByText(/Genotype × environment \(G×E\) study/)
    fireEvent.click(screen.getByRole('button', { name: /Run G×E study/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid configuration: genotype names must be unique')
  })
})
