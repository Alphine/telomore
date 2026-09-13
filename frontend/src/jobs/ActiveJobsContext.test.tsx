import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JobStatusResponse } from '../api/types'
import { mockFetch, renderApp } from '../test/helpers'
import { ActiveJobsProvider } from './ActiveJobsContext'
import { useActiveJobOfKind, useActiveJobs } from './useActiveJobs'

afterEach(() => vi.unstubAllGlobals())

const ME = { id: 1, username: 'alice', email: 'a@x.io', is_verified: true }

function job(kind: string, job_id = `job-${kind}`): JobStatusResponse {
  return {
    job_id,
    kind,
    status: 'running',
    progress: null,
    result: null,
    error: null,
    created_at: '2026-09-13T00:00:00+00:00',
    updated_at: '2026-09-13T00:00:00+00:00',
  }
}

function Probe() {
  const jobs = useActiveJobs()
  const evolve = useActiveJobOfKind('evolve')
  return (
    <div>
      <div data-testid="count">{jobs.length}</div>
      <div data-testid="evolve-job">{evolve ? evolve.job_id : 'none'}</div>
    </div>
  )
}

describe('ActiveJobsProvider', () => {
  it('polls GET /api/jobs only while authenticated and exposes the list', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: ME },
      'GET /api/jobs': { status: 200, body: [job('evolve'), job('pareto')] },
    })
    renderApp(
      <ActiveJobsProvider>
        <Probe />
      </ActiveJobsProvider>,
      { token: 'jwt' },
    )
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    expect(screen.getByTestId('evolve-job')).toHaveTextContent('job-evolve')
  })

  it('does not poll /api/jobs while anonymous', async () => {
    const fetchMock = mockFetch({})
    renderApp(
      <ActiveJobsProvider>
        <Probe />
      </ActiveJobsProvider>,
    )
    expect(screen.getByTestId('count')).toHaveTextContent('0')
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/jobs'))).toBe(false)
  })

  it('useActiveJobOfKind returns null when no job of that kind is active', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: ME },
      'GET /api/jobs': { status: 200, body: [job('sensitivity')] },
    })
    renderApp(
      <ActiveJobsProvider>
        <Probe />
      </ActiveJobsProvider>,
      { token: 'jwt' },
    )
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    expect(screen.getByTestId('evolve-job')).toHaveTextContent('none')
  })
})
