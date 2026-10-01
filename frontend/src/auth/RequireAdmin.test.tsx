import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { me } from '../test/demoHelpers'
import { mockFetch, renderApp } from '../test/helpers'
import { RequireAdmin } from './RequireAdmin'

function Tree() {
  return (
    <Routes>
      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <div>ADMIN AREA</div>
          </RequireAdmin>
        }
      />
    </Routes>
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('RequireAdmin', () => {
  it('shows a 404-style page to anonymous visitors', () => {
    mockFetch({})
    renderApp(<Tree />, { route: '/admin' })
    expect(screen.getByText('Page not found')).toBeInTheDocument()
    expect(screen.queryByText('ADMIN AREA')).not.toBeInTheDocument()
  })

  it('shows a 404-style page to ordinary and pro users', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me({ plan: 'pro' }) } })
    renderApp(<Tree />, { route: '/admin', token: 'jwt' })
    expect(await screen.findByText('Page not found')).toBeInTheDocument()
    expect(screen.queryByText('ADMIN AREA')).not.toBeInTheDocument()
  })

  it('renders the admin area for admins, after waiting for the session', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me({ is_admin: true, plan: 'pro' }) } })
    renderApp(<Tree />, { route: '/admin', token: 'jwt' })
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session')
    expect(await screen.findByText('ADMIN AREA')).toBeInTheDocument()
  })
})
