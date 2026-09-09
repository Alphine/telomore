// GET /api/meta/bounds, fetched once per page load and shared by every form
// (Simulate + Evolve both need it). The response is static for the lifetime
// of the backend process, so a module-level cache is enough.
import { useEffect, useState } from 'react'

import { metaBounds } from './endpoints'
import type { BoundsResponse } from './types'

let cache: BoundsResponse | null = null
let inflight: Promise<BoundsResponse> | null = null

function fetchBounds(): Promise<BoundsResponse> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = metaBounds()
      .then((b) => {
        cache = b
        return b
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Test hook: forget the cached response between tests. */
export function resetBoundsCache(): void {
  cache = null
  inflight = null
}

export function useBounds(): { bounds: BoundsResponse | null; error: string | null } {
  const [bounds, setBounds] = useState<BoundsResponse | null>(cache)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (bounds) return
    let cancelled = false
    fetchBounds()
      .then((b) => {
        if (!cancelled) setBounds(b)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load parameter bounds.')
      })
    return () => {
      cancelled = true
    }
  }, [bounds])

  return { bounds, error }
}
