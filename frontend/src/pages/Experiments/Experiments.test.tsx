import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExperimentSummary } from '../../api/types'
import { mockFetch, renderApp } from '../../test/helpers'
import { Experiments } from './index'
import { reproductionCommand } from './ledger'

afterEach(() => vi.unstubAllGlobals())

function row(run_id: string, kind: string, created_at: string, mine = true): ExperimentSummary {
  return {
    run_id,
    kind,
    created_at,
    fitness: 0.4123,
    runtime_seconds: 1.2,
    notes: 'via API',
    mine,
    seed: 42,
    configuration_hash: `hash-${run_id.slice(-3)}`,
    git_commit: 'abc1234',
    model_version: '0.1.0',
  }
}

const MINE = [row('TEL-20260910-001', 'simulation', '2026-09-10T00:01:00'), row('TEL-20260910-003', 'pareto', '2026-09-10T00:03:00')]
const ALL = [...MINE, row('TEL-20260910-002', 'evolution', '2026-09-10T00:02:00', false)]

const RECORD = {
  run_id: 'TEL-20260910-001',
  kind: 'simulation',
  created_at: '2026-09-10T00:01:00',
  seed: 42,
  configuration: { model: { stress_level: 0.6, cycles: 20, seed: 42 }, weights: {} },
  configuration_hash: 'hash-001',
  fitness: 0.4123,
  runtime_seconds: 1.2,
  artifacts: { result_json: 'C:/x/TEL-20260910-001/simulation.json', timeseries_csv: 'C:/x/TEL-20260910-001/timeseries.csv' },
  notes: 'via API',
  environment: {},
  model_version: '0.1.0',
  optimizer_version: '0.1.0',
  git_commit: 'abc1234',
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname + loc.search}</div>
}

describe('reproductionCommand', () => {
  it('derives the CLI command per kind, like the Streamlit page', () => {
    expect(reproductionCommand(RECORD)).toBe('python scripts/run_simulation.py --seed 42 --set stress_level=0.6 --set cycles=20')
    expect(reproductionCommand({ ...RECORD, kind: 'evolution', seed: 7 })).toContain('run_evolution.py --config <file>.yaml --seed 7')
    expect(reproductionCommand({ ...RECORD, kind: 'comparison' })).toBeNull()
  })
})

describe('Experiments page', () => {
  it('lists my runs newest first, switching tabs changes ?mine= and refetches', async () => {
    const fetchMock = mockFetch({
      'GET /api/experiments': (url) => ({ status: 200, body: url.searchParams.get('mine') === 'false' ? ALL : MINE }),
    })
    renderApp(
      <>
        <Experiments />
        <LocationProbe />
      </>,
      { route: '/experiments', token: 'jwt' },
    )
    const table = await screen.findByTestId('ledger-table')
    const ids = () => Array.from(table.querySelectorAll('tbody tr')).map((tr) => tr.querySelector('td')!.textContent)
    expect(ids()).toEqual(['TEL-20260910-003', 'TEL-20260910-001'])
    expect(table).toHaveTextContent('hash-003')
    expect(table).toHaveTextContent('abc1234')
    expect(table).toHaveTextContent('+0.4123')
    expect(screen.getByRole('tab', { name: 'My experiments' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'All experiments' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/experiments?mine=false')
    await waitFor(() => expect(screen.getByTestId('ledger-table').querySelectorAll('tbody tr')).toHaveLength(3))
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/experiments?mine=false'))).toBe(true)
    expect(screen.getByRole('tab', { name: 'All experiments' })).toHaveAttribute('aria-selected', 'true')
  })

  it('clicking a row loads the record, the reproduction command and artifact links that point at the API', async () => {
    const fetchMock = mockFetch({
      'GET /api/experiments': { status: 200, body: MINE },
      'GET /api/experiments/TEL-20260910-001': { status: 200, body: { record: RECORD, artifacts: RECORD.artifacts } },
      'GET /api/experiments/TEL-20260910-001/artifacts': {
        status: 200,
        body: [
          { name: 'config.json', key: 'config_json', size_bytes: 400, media_type: 'application/json' },
          { name: 'record.json', key: null, size_bytes: 2048, media_type: 'application/json' },
          { name: 'timeseries.csv', key: 'timeseries_csv', size_bytes: 1500, media_type: 'text/csv' },
        ],
      },
      'GET /api/experiments/TEL-20260910-001/artifacts/timeseries.csv': { status: 200, body: 'cycle,mean_length_bp\n0,7500\n' },
    })
    renderApp(
      <>
        <Experiments />
        <LocationProbe />
      </>,
      { route: '/experiments', token: 'jwt' },
    )
    await screen.findByTestId('ledger-table')
    fireEvent.click(screen.getByRole('button', { name: 'TEL-20260910-001' }))
    expect(screen.getByTestId('location')).toHaveTextContent('run=TEL-20260910-001')

    expect(await screen.findByTestId('reproduce-command')).toHaveTextContent(
      'python scripts/run_simulation.py --seed 42 --set stress_level=0.6 --set cycles=20',
    )
    expect(screen.getByTestId('metric-row')).toHaveTextContent('hash-001')
    expect(screen.getByTestId('metric-row')).toHaveTextContent('abc1234')
    const links = Array.from(screen.getByTestId('artifact-list').querySelectorAll('a')) as HTMLAnchorElement[]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/api/experiments/TEL-20260910-001/artifacts/config.json',
      '/api/experiments/TEL-20260910-001/artifacts/record.json',
      '/api/experiments/TEL-20260910-001/artifacts/timeseries.csv',
    ])
    expect(screen.getByText('timeseries_csv')).toBeInTheDocument()
    expect(screen.getByText(/text\/csv · 1\.5 kB/)).toBeInTheDocument()

    // Clicking fetches the file with the bearer token (a bare link could not) and saves the Blob.
    // requestBlob reads the stored token (renderApp's initialToken is in-memory only).
    window.localStorage.setItem('tel_token', 'jwt')
    const createObjectURL = vi.fn(() => 'blob:x')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    fireEvent.click(links[2])
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            String(u).endsWith('/artifacts/timeseries.csv') &&
            (init?.headers as Record<string, string>).Authorization === 'Bearer jwt',
        ),
      ).toBe(true),
    )
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
  })

  it('opens the run named in ?run= directly and shows an empty state for no runs', async () => {
    mockFetch({
      'GET /api/experiments': { status: 200, body: [] },
      'GET /api/experiments/TEL-20260910-001': { status: 200, body: { record: RECORD, artifacts: {} } },
      'GET /api/experiments/TEL-20260910-001/artifacts': { status: 200, body: [] },
    })
    renderApp(<Experiments />, { route: '/experiments?run=TEL-20260910-001', token: 'jwt' })
    expect(await screen.findByText(/You have not recorded any runs yet/)).toBeInTheDocument()
    expect(await screen.findByTestId('reproduce-command')).toBeInTheDocument()
    expect(screen.getByText("No files in this run's directory.")).toBeInTheDocument()
  })
})
