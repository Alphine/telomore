import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import { Home } from './Home'

afterEach(() => vi.unstubAllGlobals())

const ME = { id: 1, username: 'alice', email: 'a@x.io', is_verified: true }

function Tree() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/verify" element={<div>VERIFY ROUTE</div>} />
      <Route path="/reset-password" element={<div>RESET ROUTE</div>} />
    </Routes>
  )
}

describe('Home ("/") route', () => {
  it('redirects backend-style /?token= and /?reset_token= links onto their routes, even when anonymous', async () => {
    mockFetch({})
    const first = renderApp(<Tree />, { route: '/?token=abc' })
    expect(await screen.findByText('VERIFY ROUTE')).toBeInTheDocument()
    first.unmount()
    renderApp(<Tree />, { route: '/?reset_token=xyz' })
    expect(await screen.findByText('RESET ROUTE')).toBeInTheDocument()
  })

  it('shows the pre-login Showcase page (no sidebar) when anonymous', async () => {
    mockFetch({})
    renderApp(<Tree />)
    expect(await screen.findByText('Ready to run your first experiment?')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Lab pages' })).not.toBeInTheDocument()
  })

  it('shows the sidebar-wrapped Landing dashboard when authenticated', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: ME },
      'GET /api/jobs': { status: 200, body: [] },
      'GET /api/health': { status: 200, body: { status: 'ok' } },
    })
    renderApp(<Tree />, { token: 'jwt' })
    expect(await screen.findByRole('navigation', { name: 'Lab pages' })).toBeInTheDocument()
    expect(screen.getByText('Simulate. Evolve. Compare. Learn.')).toBeInTheDocument()
  })
})
