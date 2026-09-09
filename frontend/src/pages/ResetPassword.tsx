import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import { resetPassword } from '../api/endpoints'
import { AuthCard } from '../components/AuthCard'
import { Callout } from '../components/Callout'

export function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!password) {
      setError('Enter a new password.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      const res = await resetPassword({ token, new_password: password })
      setMessage(res.message)
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <AuthCard title="Set a new password">
        <Callout tone="error" role="alert">
          This page needs a reset token in the URL. Request a new link from{' '}
          <Link className="link" to="/forgot-password">
            Forgot password
          </Link>
          .
        </Callout>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Set a new password"
      footer={
        <Link className="link" to="/login">
          ← Back to log in
        </Link>
      }
    >
      {message ? (
        <Callout tone="success" role="status">
          {message}
        </Callout>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label className="label" htmlFor="reset-password">
              New password
            </label>
            <input
              id="reset-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="reset-confirm">
              Confirm new password
            </label>
            <input
              id="reset-confirm"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      )}
    </AuthCard>
  )
}
