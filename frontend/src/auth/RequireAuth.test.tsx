import { screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import { RequireAuth } from './RequireAuth'

function Tree() {
  return (
    <Routes>
      <Route path="/login" element={<div>LOGIN PAGE</div>} />
      <Route
        path="/simulate"
        element={
          <RequireAuth>
            <div>SECRET CONTENT</div>
          </RequireAuth>
        }
      />
    </Routes>
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('RequireAuth', () => {
  it('redirects anonymous users to /login?next=<path>', async () => {
    mockFetch({})
    renderApp(<Tree />, { route: '/simulate?x=1' })
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument()
    expect(screen.queryByText('SECRET CONTENT')).not.toBeInTheDocument()
  })

  it('renders children once /auth/me accepts the stored token', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/me': { status: 200, body: { id: 1, username: 'alice', email: 'a@x.io', is_verified: true } },
    })
    renderApp(<Tree />, { route: '/simulate', token: 'jwt-123' })
    expect(await screen.findByText('SECRET CONTENT')).toBeInTheDocument()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123')
  })

  it('clears a rejected token and redirects', async () => {
    window.localStorage.setItem('tel_token', 'stale')
    mockFetch({ 'GET /api/auth/me': { status: 401, body: { detail: 'Could not validate credentials' } } })
    renderApp(<Tree />, { route: '/simulate', token: 'stale' })
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument()
    await waitFor(() => expect(window.localStorage.getItem('tel_token')).toBeNull())
  })
})
