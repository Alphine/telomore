import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import type { FakeResponse } from '../test/helpers'
import UsersPage from './UsersPage'
import { chooseOption, installDomStubs, makeUser, pageOf } from './testSupport'

beforeAll(installDomStubs)

const alice = makeUser({ id: 1, username: 'alice', email: 'alice@example.org' })
const bob = makeUser({ id: 2, username: 'bob', email: 'bob@example.org', plan: 'pro', plan_effective: 'pro', is_disabled: true })

function queryOf(fn: ReturnType<typeof mockFetch>, nth = -1): URLSearchParams {
  const calls = fn.mock.calls.filter(([u]) => String(u).includes('/admin/users?'))
  const [u] = calls.at(nth) ?? []
  return new URL(String(u), 'http://localhost').searchParams
}

function usersCalls(fn: ReturnType<typeof mockFetch>): number {
  return fn.mock.calls.filter(([u]) => String(u).includes('/admin/users?')).length
}

const detail = (u = alice) => ({ status: 200, body: { ...u, runs_count: 2, recent_usage: [], requests: [] } })

describe('UsersPage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders rows and refetches with the right query on search, filter, sort and paging', async () => {
    const fn = mockFetch({
      'GET /api/admin/users': () => ({ status: 200, body: pageOf([alice, bob], { total: 60, pages: 3 }) }),
    })
    renderApp(<UsersPage />, { token: 'tok' })

    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByTestId('pager-count')).toHaveTextContent('60 users')
    expect(queryOf(fn).get('sort')).toBe('-created_at')
    expect(queryOf(fn).get('page')).toBe('1')
    expect(queryOf(fn).get('page_size')).toBe('25')
    expect(queryOf(fn).has('query')).toBe(false) // empty params are dropped
    expect(queryOf(fn).has('plan')).toBe(false)

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'ali' } })
    await waitFor(() => expect(queryOf(fn).get('query')).toBe('ali'))

    chooseOption('Plan filter', 'Pro')
    await waitFor(() => expect(queryOf(fn).get('plan')).toBe('pro'))

    chooseOption('Status filter', 'Disabled')
    await waitFor(() => expect(queryOf(fn).get('status')).toBe('disabled'))

    fireEvent.click(screen.getByRole('button', { name: 'User' }))
    await waitFor(() => expect(queryOf(fn).get('sort')).toBe('username'))
    expect(screen.getByRole('columnheader', { name: 'User' })).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(screen.getByRole('button', { name: 'User' }))
    await waitFor(() => expect(queryOf(fn).get('sort')).toBe('-username'))

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(queryOf(fn).get('page')).toBe('2'))
    // every filter is still in the request
    expect(queryOf(fn).get('query')).toBe('ali')
    expect(queryOf(fn).get('plan')).toBe('pro')
    expect(queryOf(fn).get('status')).toBe('disabled')
  })

  it('sends the plan PATCH body and keeps the new plan on success', async () => {
    const patched = { ...alice, plan: 'pro', plan_effective: 'pro' }
    const fn = mockFetch({
      'GET /api/admin/users': { status: 200, body: pageOf([alice]) },
      'GET /api/admin/users/1': detail(),
      'PATCH /api/admin/users/1': { status: 200, body: patched },
    })
    renderApp(<UsersPage />, { token: 'tok' })
    fireEvent.click(await screen.findByRole('row', { name: 'Open alice' }))

    fireEvent.click(await screen.findByRole('radio', { name: 'pro' }))
    fireEvent.click(screen.getByRole('button', { name: 'No expiry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    await waitFor(() => expect(fn.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true))
    const call = fn.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ plan: 'pro', plan_expires_at: null })
    await waitFor(() => expect(document.querySelector('#user-row-1 [data-testid="plan-badge"]')).toHaveAttribute('aria-label', 'Plan: Pro'))
  })

  it('rolls back the optimistic plan change and toasts on a 409', async () => {
    const resp: FakeResponse = { status: 409, body: { detail: { code: 'admin_protected', message: 'nope' } } }
    const fn = mockFetch({
      'GET /api/admin/users': { status: 200, body: pageOf([alice]) },
      'GET /api/admin/users/1': detail(),
      'PATCH /api/admin/users/1': resp,
    })
    renderApp(<UsersPage />, { token: 'tok' })
    fireEvent.click(await screen.findByRole('row', { name: 'Open alice' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'pro' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(await screen.findByText('Could not update alice')).toBeInTheDocument()
    expect(screen.getByText(/cannot be disabled or moved to the free plan/i)).toBeInTheDocument()
    const badge = document.querySelector('#user-row-1 [data-testid="plan-badge"]')
    expect(badge).toHaveAttribute('aria-label', 'Plan: Free')
    const body = JSON.parse(String(fn.mock.calls.find(([, i]) => i?.method === 'PATCH')?.[1]?.body))
    expect(body).toEqual({ plan: 'pro', plan_expires_at: null })
  })

  it('creates a user and shows the temporary password once with a copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const created = makeUser({ id: 9, username: 'newbie', email: 'n@example.org' })
    const fn = mockFetch({
      'GET /api/admin/users': { status: 200, body: pageOf([alice]) },
      'POST /api/admin/users': { status: 201, body: { user: created, temporary_password: 'Tmp-Secret-123' } },
    })
    renderApp(<UsersPage />, { token: 'tok' })
    await screen.findByText('alice')
    const before = usersCalls(fn)

    fireEvent.click(screen.getByRole('button', { name: /Create user/ }))
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'newbie' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'n@example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }))

    expect(await screen.findByTestId('temp-password')).toHaveTextContent('Tmp-Secret-123')
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument()
    const post = fn.mock.calls.find(([, i]) => i?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ username: 'newbie', email: 'n@example.org', plan: 'free', plan_days: null })

    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Tmp-Secret-123'))
    expect(await screen.findByText('Password copied')).toBeInTheDocument()

    await waitFor(() => expect(usersCalls(fn)).toBeGreaterThan(before)) // table refreshed
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByTestId('temp-password')).not.toBeInTheDocument())
    expect(screen.queryByText('Tmp-Secret-123')).not.toBeInTheDocument()
  })
})
