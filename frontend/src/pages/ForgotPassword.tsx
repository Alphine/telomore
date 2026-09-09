import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../api/client'
import { forgotPassword } from '../api/endpoints'
import type { ForgotPasswordResponse } from '../api/types'
import { AuthCard } from '../components/AuthCard'
import { Callout } from '../components/Callout'
import { DevLink } from '../components/DevLink'

export function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<ForgotPasswordResponse | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email) {
      setError('Enter your account email.')
      return
    }
    setBusy(true)
    try {
      setDone(await forgotPassword({ email }))
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard
      title="Forgot password"
      subtitle="Enter your account email and we will send a reset link, valid for one hour."
      footer={
        <Link className="link" to="/login">
          ← Back to log in
        </Link>
      }
    >
      {done ? (
        <>
          <Callout tone="success" role="status">
            {done.message}
          </Callout>
          {done.dev_reset_link && <DevLink link={done.dev_reset_link} label="Reset your password" />}
        </>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label className="label" htmlFor="forgot-email">
              Account email
            </label>
            <input
              id="forgot-email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthCard>
  )
}
