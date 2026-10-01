import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Account } from '../pages/Account'
import { me } from '../test/demoHelpers'
import { mockFetch, renderApp } from '../test/helpers'
import { AccessRequestForm, MAX_REQUEST_MESSAGE } from './AccessRequestForm'

afterEach(() => vi.unstubAllGlobals())

const REQ = { id: 5, status: 'pending', message: 'Doing a thesis', created_at: '2026-09-30T10:00:00Z', decided_at: null, decision_note: null }

describe('AccessRequestForm', () => {
  it('counts characters, blocks messages over 500 and posts the message', async () => {
    const fetchMock = mockFetch({ 'POST /api/access-requests': { status: 201, body: REQ } })
    const onSubmitted = vi.fn()
    renderApp(<AccessRequestForm onSubmitted={onSubmitted} />, { token: 'jwt' })

    const box = screen.getByLabelText(/why do you need pro access/i)
    expect(screen.getByText(`0/${MAX_REQUEST_MESSAGE}`)).toBeInTheDocument()

    fireEvent.change(box, { target: { value: 'x'.repeat(MAX_REQUEST_MESSAGE + 1) } })
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()

    fireEvent.change(box, { target: { value: '  Doing a thesis  ' } })
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ id: 5 })))
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/access-requests'))!
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ message: 'Doing a thesis' })
    expect((box as HTMLTextAreaElement).value).toBe('')
  })

  it('shows the API error for a duplicate pending request', async () => {
    mockFetch({
      'POST /api/access-requests': { status: 409, body: { detail: { code: 'request_pending', message: 'You already have a pending request.' } } },
    })
    renderApp(<AccessRequestForm />, { token: 'jwt' })
    fireEvent.change(screen.getByLabelText(/why do you need pro access/i), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a pending request.')
  })
})

describe('Account page', () => {
  it('free user without requests: shows plan, the form and sends a request', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: me() },
      'GET /api/access-requests/mine': { status: 200, body: [] },
      'POST /api/access-requests': { status: 201, body: REQ },
    })
    renderApp(<Account />, { token: 'jwt' })
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('Precomputed examples only')).toBeInTheDocument()
    expect(await screen.findByLabelText(/why do you need pro access/i)).toBeInTheDocument()
  })

  it('pending request: shows its status and hides the form', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: me({ pending_request: true }) },
      'GET /api/access-requests/mine': { status: 200, body: [REQ] },
    })
    renderApp(<Account />, { token: 'jwt' })
    expect(await screen.findByText(/Your request is pending review/)).toBeInTheDocument()
    expect(screen.getByTestId('request-status-5')).toHaveTextContent('pending')
    expect(screen.queryByLabelText(/why do you need pro access/i)).not.toBeInTheDocument()
  })

  it('rejected request shows the admin note and lets the user ask again', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: me() },
      'GET /api/access-requests/mine': {
        status: 200,
        body: [{ ...REQ, status: 'rejected', decision_note: 'Please add details' }],
      },
    })
    renderApp(<Account />, { token: 'jwt' })
    expect(await screen.findByText(/Please add details/)).toBeInTheDocument()
    expect(screen.getByTestId('request-status-5')).toHaveTextContent('rejected')
    expect(screen.getByLabelText(/why do you need pro access/i)).toBeInTheDocument()
  })

  it('pro user: shows expiry and no request form', async () => {
    mockFetch({
      'GET /api/auth/me': { status: 200, body: me({ plan: 'pro', plan_expires_at: '2027-03-01T00:00:00Z' }) },
      'GET /api/access-requests/mine': {
        status: 200,
        body: [{ ...REQ, status: 'approved' }],
      },
    })
    renderApp(<Account />, { token: 'jwt' })
    expect(await screen.findByText('Enabled')).toBeInTheDocument()
    expect(screen.getByTestId('request-status-5')).toHaveTextContent('approved')
    expect(screen.queryByLabelText(/why do you need pro access/i)).not.toBeInTheDocument()
  })
})
