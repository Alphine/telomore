import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import { Verify } from './Verify'

afterEach(() => vi.unstubAllGlobals())

describe('Verify page', () => {
  it('calls GET /api/auth/verify?token=<query token> and shows success', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/verify': (url) => ({
        status: 200,
        body: { message: `Email verified for 'alice'. You can now log in.`, verified: url.searchParams.get('token') === 'tok-42' },
      }),
    })
    renderApp(<Verify />, { route: '/verify?token=tok-42' })
    expect(await screen.findByRole('status')).toHaveTextContent('Email verified')
    const [calledUrl] = fetchMock.mock.calls[0]
    const u = new URL(String(calledUrl), 'http://localhost')
    expect(u.pathname).toBe('/api/auth/verify')
    expect(u.searchParams.get('token')).toBe('tok-42')
    expect(screen.getByRole('link', { name: /Go to log in/ })).toHaveAttribute('href', '/login')
  })

  it('shows the failure message when verified=false', async () => {
    mockFetch({
      'GET /api/auth/verify': {
        status: 200,
        body: { message: 'That verification link is invalid or has already been used.', verified: false },
      },
    })
    renderApp(<Verify />, { route: '/verify?token=used' })
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or has already been used')
  })

  it('explains when no token is present and makes no API call', () => {
    const fetchMock = mockFetch({})
    renderApp(<Verify />, { route: '/verify' })
    expect(screen.getByRole('alert')).toHaveTextContent('needs a verification token')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
