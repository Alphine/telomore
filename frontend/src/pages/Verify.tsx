import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import { verifyEmail } from '../api/endpoints'
import { AuthCard } from '../components/AuthCard'
import { Callout } from '../components/Callout'

type State = { state: 'pending' } | { state: 'done'; verified: boolean; message: string }

export function Verify() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [result, setResult] = useState<State>({ state: 'pending' })

  useEffect(() => {
    if (!token) return
    let cancelled = false
    verifyEmail(token)
      .then((r) => {
        if (!cancelled) setResult({ state: 'done', verified: r.verified, message: r.message })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({
            state: 'done',
            verified: false,
            message: err instanceof ApiError ? err.message : 'Could not reach the API.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <AuthCard
      title="Verify your email"
      footer={
        <Link className="link" to="/login">
          Go to log in →
        </Link>
      }
    >
      {!token ? (
        <Callout tone="error" role="alert">
          This page needs a verification token in the URL. Open the link from your verification email (or the
          dev-mode link shown after registering).
        </Callout>
      ) : result.state === 'pending' ? (
        <Callout tone="info" role="status">
          Verifying…
        </Callout>
      ) : result.verified ? (
        <Callout tone="success" role="status">
          ✅ {result.message}
        </Callout>
      ) : (
        <Callout tone="error" role="alert">
          {result.message}
        </Callout>
      )}
    </AuthCard>
  )
}
