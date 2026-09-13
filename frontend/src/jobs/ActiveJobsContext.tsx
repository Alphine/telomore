// Global "jobs currently running" tracker, mounted once in Layout.tsx (which
// stays mounted across route changes -- only its <Outlet/> child swaps).
//
// Fixes a real bug: each job page (Evolve/Pareto/Sensitivity/GxE/
// ActiveLearning) stores its own jobId in plain component state with zero
// persistence, so navigating away permanently loses track of that job --
// even though it keeps running server-side on a detached daemon thread,
// completely unaffected (backend/jobs.py::run_job). This context polls the
// server's own source of truth (GET /api/jobs) at a light cadence, so a
// page can re-adopt its in-flight job on remount, and the nav can show a
// persistent "in progress" badge regardless of which page is active.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { listJobs } from '../api/endpoints'
import type { JobStatusResponse } from '../api/types'
import { useAuth } from '../auth/context'
import { ActiveJobsContext } from './useActiveJobs'

const POLL_INTERVAL_MS = 4000

export function ActiveJobsProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const [jobs, setJobs] = useState<JobStatusResponse[]>([])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // A setTimeout chain (not setInterval), same idiom as api/useJob.ts, so a
    // slow response never overlaps the next poll. The `status` check lives
    // inside this async function (not the effect body itself) so the
    // resulting setState is never synchronous-within-the-effect.
    const tick = async () => {
      if (status !== 'authenticated') {
        // No further polling while logged out; the effect re-runs (and
        // starts a fresh chain) the moment `status` changes.
        if (!cancelled) setJobs([])
        return
      }
      try {
        const list = await listJobs()
        if (!cancelled) setJobs(list)
      } catch {
        // Transient polling errors keep the last known list rather than
        // flashing the badge away -- this is a convenience indicator, not a
        // source of truth a page depends on for correctness.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    void tick()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [status])

  return <ActiveJobsContext.Provider value={jobs}>{children}</ActiveJobsContext.Provider>
}
