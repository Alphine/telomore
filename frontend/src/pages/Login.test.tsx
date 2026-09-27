import { fireEvent, screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import { Login } from './Login'

afterEach(() => vi.unstubAllGlobals())

function fillAndSubmit(username = 'alice', password = 'pw') {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

describe('Login page', () => {
  it('shows "wrong credentials" on 401', async () => {
    mockFetch({ 'POST /api/auth/login': { status: 401, body: { detail: 'Wrong username or password.' } } })
    renderApp(<Login />, { route: '/login' })
    fillAndSubmit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.')
    expect(screen.queryByText(/Email not verified/)).not.toBeInTheDocument()
  })

  it('shows "email not verified" hint on 403', async () => {
    mockFetch({
      'POST /api/auth/login': {
        status: 403,
        body: { detail: 'Please verify your email before logging in. Check your inbox for a verification link.' },
      },
    })
    renderApp(<Login />, { route: '/login' })
    fillAndSubmit()
    expect(await screen.findByRole('alert')).toHaveTextContent('Email not verified')
    expect(screen.queryByText('Wrong username or password.')).not.toBeInTheDocument()
  })

  it('stores the token, fetches /me and redirects to ?next on 200', async () => {
    const fetchMock = mockFetch({
      'POST /api/auth/login': { status: 200, body: { access_token: 'jwt-abc', token_type: 'bearer' } },
      'GET /api/auth/me': { status: 200, body: { id: 1, username: 'alice', email: 'a@x.io', is_verified: true } },
    })
    renderApp(
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/evolve" element={<div>EVOLVE PAGE</div>} />
      </Routes>,
      { route: '/login?next=%2Fevolve' },
    )
    fillAndSubmit()
    expect(await screen.findByText('EVOLVE PAGE')).toBeInTheDocument()
    expect(window.localStorage.getItem('tel_token')).toBe('jwt-abc')
    const meCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/auth/me'))
    expect(meCall).toBeTruthy()
  })
})
