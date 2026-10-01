import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import RequestsPage from './RequestsPage'
import { installDomStubs, makeRequest, pageOf } from './testSupport'

beforeAll(installDomStubs)

describe('RequestsPage', () => {
  it('approves with plan_days and note and removes the card', async () => {
    const r = makeRequest()
    const fn = mockFetch({
      'GET /api/admin/requests': { status: 200, body: pageOf([r]) },
      'POST /api/admin/requests/5/approve': { status: 200, body: { ...r, status: 'approved' } },
    })
    renderApp(<RequestsPage />, { token: 'tok' })
    expect(await screen.findByText('bob')).toBeInTheDocument()
    expect(fn.mock.calls[0][0]).toContain('status=pending')

    fireEvent.click(screen.getByRole('button', { name: 'Approve bob' }))
    fireEvent.click(await screen.findByRole('button', { name: '90 days' }))
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'ok' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(screen.queryByTestId('request-5')).not.toBeInTheDocument())
    const post = fn.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ plan_days: 90, note: 'ok' })
    expect(await screen.findByText('No pending requests')).toBeInTheDocument()
  })

  it('puts the card back and toasts when the decision fails', async () => {
    const r = makeRequest()
    mockFetch({
      'GET /api/admin/requests': { status: 200, body: pageOf([r]) },
      'POST /api/admin/requests/5/reject': { status: 500, body: { detail: 'boom' } },
    })
    renderApp(<RequestsPage />, { token: 'tok' })
    fireEvent.click(await screen.findByRole('button', { name: 'Reject bob' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(await screen.findByText('Could not reject bob')).toBeInTheDocument()
    expect(screen.getByTestId('request-5')).toBeInTheDocument()
  })
})
