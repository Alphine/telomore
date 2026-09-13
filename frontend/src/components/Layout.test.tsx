import { screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JobStatusResponse } from '../api/types'
import { mockFetch, renderApp } from '../test/helpers'
import { Layout } from './Layout'

afterEach(() => vi.unstubAllGlobals())

const ME = { id: 1, username: 'alice', email: 'a@x.io', is_verified: true }

function job(kind: string): JobStatusResponse {
  return {
    job_id: `job-${kind}`,
    kind,
    status: 'running',
    progress: null,
    result: null,
    error: null,
    created_at: '2026-09-13T00:00:00+00:00',
    updated_at: '2026-09-13T00:00:00+00:00',
  }
}

function Tree() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<div>HOME</div>} />
      </Route>
    </Routes>
  )
}

describe('Layout nav', () => {
  it('shows a job-in-progress badge next to the matching feature link', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: ME },
      'GET /api/jobs': { status: 200, body: [job('evolve')] },
    })
    renderApp(<Tree />, { token: 'jwt' })
    await waitFor(() => expect(screen.getAllByTestId('nav-job-badge-/evolve').length).toBeGreaterThan(0))
    expect(screen.queryByTestId('nav-job-badge-/pareto')).not.toBeInTheDocument()
  })

  it('shows no badges when nothing is running', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: ME },
      'GET /api/jobs': { status: 200, body: [] },
    })
    renderApp(<Tree />, { token: 'jwt' })
    await screen.findByText('HOME')
    expect(screen.queryByTestId('nav-job-badge-/evolve')).not.toBeInTheDocument()
  })

  it('shows no badges for an anonymous visitor', async () => {
    mockFetch({})
    renderApp(<Tree />)
    await screen.findByText('HOME')
    expect(screen.queryByTestId('nav-job-badge-/evolve')).not.toBeInTheDocument()
  })
})
