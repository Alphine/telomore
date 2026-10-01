import type { ReactNode } from 'react'

import { useAccess } from '../access/context'
import { NotFound } from '../pages/NotFound'

/**
 * Guard for /admin/*. Anyone who is not an admin (including anonymous visitors
 * and ordinary users) sees the same 404 page as for an unknown URL, so the
 * existence of the admin area is not advertised.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, isAdmin } = useAccess()
  if (status === 'loading') {
    return (
      <div className="prose-muted py-12 text-center" role="status">
        Checking your session…
      </div>
    )
  }
  if (!isAdmin) return <NotFound />
  return <>{children}</>
}
