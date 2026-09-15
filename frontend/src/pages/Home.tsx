import { Navigate, useSearchParams } from 'react-router-dom'

import { useAuth } from '../auth/context'
import { Layout } from '../components/Layout'
import { Landing } from './Landing'
import { Showcase } from './Showcase'

/**
 * The actual "/" route element (2026-09-16). Picks between the pre-login
 * Showcase page (anonymous visitors -- a standalone, full-bleed "show off"
 * page, no sidebar) and the sidebar-wrapped Landing dashboard (authenticated
 * users), so a returning logged-in user still lands on their usual home base
 * rather than the marketing page every time.
 */
export function Home() {
  // The backend builds emailed / dev-mode links as `/?token=` and
  // `/?reset_token=` on the root path (backend/routers/auth.py) -- checked
  // first, before Showcase-vs-Landing, so a link like that still works for
  // an anonymous visitor who hasn't logged in yet.
  const [params] = useSearchParams()
  const { status } = useAuth()
  const verifyToken = params.get('token')
  const resetToken = params.get('reset_token')
  if (verifyToken) return <Navigate to={`/verify?token=${encodeURIComponent(verifyToken)}`} replace />
  if (resetToken) return <Navigate to={`/reset-password?token=${encodeURIComponent(resetToken)}`} replace />

  if (status === 'loading') {
    return (
      <div className="prose-muted flex min-h-screen items-center justify-center py-12 text-center" role="status">
        Checking your session…
      </div>
    )
  }
  if (status === 'authenticated') {
    return (
      <Layout>
        <Landing />
      </Layout>
    )
  }
  return <Showcase />
}
