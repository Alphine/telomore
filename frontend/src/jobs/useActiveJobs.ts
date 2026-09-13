// Pure hooks over the ActiveJobsContext, split into their own module so
// ActiveJobsContext.tsx only exports the provider component (React Fast
// Refresh / oxlint convention -- see auth/context.ts's own split from
// auth/AuthContext.tsx for the same pattern).
import { createContext, useContext } from 'react'

import type { JobStatusResponse } from '../api/types'

export const ActiveJobsContext = createContext<JobStatusResponse[]>([])

/** Every active (pending/running) job owned by the current user, polled every ~4s. */
export function useActiveJobs(): JobStatusResponse[] {
  return useContext(ActiveJobsContext)
}

/** The first active job of a given `kind` (e.g. "evolve", "pareto"), or null. */
export function useActiveJobOfKind(kind: string): JobStatusResponse | null {
  return useActiveJobs().find((j) => j.kind === kind) ?? null
}
