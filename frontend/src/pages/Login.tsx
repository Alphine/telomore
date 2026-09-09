import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { useAuth } from '../auth/context'
import { safeNext } from '../auth/safeNext'
import { AuthCard } from '../components/AuthCard'
import { Callout } from '../components/Callout'

export function Login() {
  const { login, status } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ kind: 'wrong_credentials' | 'not_verified' | 'error'; message: string } | null>(
    null,
  )

  // Once the token is accepted by /auth/me, send the user on.
  useEffect(() => {
    if (status === 'authenticated') navigate(next, { replace: true })
  }, [status, navigate, next])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!username || !password) {
      setError({ kind: 'error', message: 'Enter both a username and a password.' })
      return
    }
    setBusy(true)
    const out = await login(username, password)
    setBusy(false)
    if (!out.ok) setError({ kind: out.reason, message: out.message })
  }

  return (
    <AuthCard
      title="Log in"
      subtitle="Log in to use Simulate, Evolve, Pareto, Sensitivity, Active Learning, Compare and Experiments. The Home page is public."
      footer={
        <>
          No account yet?{' '}
          <Link className="link" to="/register">
            Register
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="login-username">
            Username
          </label>
          <input
            id="login-username"
            className="input"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && error.kind === 'wrong_credentials' && (
          <Callout tone="error" role="alert">
            Wrong username or password.
          </Callout>
        )}
        {error && error.kind === 'not_verified' && (
          <Callout tone="warning" role="alert">
            <div className="font-medium">Email not verified.</div>
            <div className="mt-1">
              Please verify your email before logging in — check your inbox for a verification link. If you
              registered in dev mode, use the verification link shown on the{' '}
              <Link className="link" to="/register">
                Register
              </Link>{' '}
              page.
            </div>
          </Callout>
        )}
        {error && error.kind === 'error' && (
          <Callout tone="error" role="alert">
            {error.message}
          </Callout>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy || status === 'loading'}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <div className="text-center">
          <Link className="link text-sm" to="/forgot-password">
            Forgot password?
          </Link>
        </div>
      </form>
    </AuthCard>
  )
}
