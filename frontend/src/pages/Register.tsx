import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../api/client'
import { register } from '../api/endpoints'
import type { RegisterResponse } from '../api/types'
import { AuthCard } from '../components/AuthCard'
import { Callout } from '../components/Callout'
import { DevLink } from '../components/DevLink'

export function Register() {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<RegisterResponse | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!username || !email || !password) {
      setError('Fill in username, email and password.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    try {
      setDone(await register({ username, email, password }))
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthCard
        title="Account created"
        footer={
          <Link className="link" to="/login">
            Go to log in →
          </Link>
        }
      >
        <Callout tone="success" role="status">
          {done.message}
        </Callout>
        {done.dev_verification_link && <DevLink link={done.dev_verification_link} label="Verify this account" />}
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Create account"
      subtitle="Create a free account to use the lab. A fresh account starts unverified — you will need to click the verification link before logging in."
      footer={
        <>
          Already registered?{' '}
          <Link className="link" to="/login">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="reg-username">
            Choose a username
          </label>
          <input
            id="reg-username"
            className="input"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="reg-email">
            Email address
          </label>
          <input
            id="reg-email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="reg-password">
            Choose a password
          </label>
          <input
            id="reg-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="reg-confirm">
            Confirm password
          </label>
          <input
            id="reg-confirm"
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
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  )
}
