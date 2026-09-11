// GET /api/meta/chip-presets, fetched once per page load and shared by every
// consumer -- same module-level-cache pattern as useBounds.ts. The response
// is static for the lifetime of the backend process.
import { useEffect, useState } from 'react'

import { metaChipPresets } from './endpoints'
import type { ChipPresetsResponse } from './types'

let cache: ChipPresetsResponse | null = null
let inflight: Promise<ChipPresetsResponse> | null = null

function fetchChipPresets(): Promise<ChipPresetsResponse> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = metaChipPresets()
      .then((r) => {
        cache = r
        return r
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Test hook: forget the cached response between tests. */
export function resetChipPresetsCache(): void {
  cache = null
  inflight = null
}

export function useChipPresets(): { presets: ChipPresetsResponse | null; error: string | null } {
  const [presets, setPresets] = useState<ChipPresetsResponse | null>(cache)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (presets) return
    let cancelled = false
    fetchChipPresets()
      .then((r) => {
        if (!cancelled) setPresets(r)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load organ-chip presets.')
      })
    return () => {
      cancelled = true
    }
  }, [presets])

  return { presets, error }
}
