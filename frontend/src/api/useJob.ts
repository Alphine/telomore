// Polling hook for the background-job contract in docs/API.md
// (GET /api/jobs/{id} until a terminal status, POST .../stop to cancel).
// Shared by Evolve (Phase 3) and, in Phase 4, Pareto / Sensitivity /
// Active Learning -- the job shape is identical, only `progress` / `result`
// differ (hence the generics).
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from './client'
import { getJob, stopJob } from './endpoints'
import { TERMINAL_JOB_STATUSES } from './types'
import type { JobStatusResponse } from './types'

export interface UseJobOptions {
  /** Delay between polls, in ms (default 1000). */
  intervalMs?: number
}

export interface UseJobResult<P, R> {
  /** Latest job snapshot, or null before the first successful poll / when jobId is null. */
  job: JobStatusResponse<P, R> | null
  /** Last polling/stop error message (cleared on the next successful poll). */
  error: string | null
  /** True while a job is set and has not reached a terminal status. */
  isActive: boolean
  /** Request cooperative cancellation (POST /api/jobs/{id}/stop). */
  stop: () => Promise<void>
}

interface Snapshot<P, R> {
  id: string
  job: JobStatusResponse<P, R> | null
  error: string | null
}

export function useJob<P = Record<string, unknown>, R = Record<string, unknown>>(
  jobId: string | null,
  opts: UseJobOptions = {},
): UseJobResult<P, R> {
  const intervalMs = opts.intervalMs ?? 1000
  // State is keyed by job id so switching jobs needs no reset-in-effect: a
  // snapshot for a different id is simply ignored during render.
  const [snap, setSnap] = useState<Snapshot<P, R> | null>(null)
  // Set once a terminal snapshot has been adopted (from a poll or from
  // stop()); a poll that was already in flight at that moment must not
  // overwrite it with a stale non-terminal status.
  const doneRef = useRef(false)

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    doneRef.current = false

    // A setTimeout chain (not setInterval) so a slow response never overlaps
    // the next poll, and so a terminal status ends the chain cleanly.
    const tick = async () => {
      try {
        const snapshot = await getJob<P, R>(jobId)
        if (cancelled || doneRef.current) return
        setSnap({ id: jobId, job: snapshot, error: null })
        if (TERMINAL_JOB_STATUSES.has(snapshot.status)) {
          doneRef.current = true
          return
        }
      } catch (err: unknown) {
        if (cancelled || doneRef.current) return
        const message = err instanceof Error ? err.message : 'Could not reach the API.'
        setSnap((prev) => ({ id: jobId, job: prev?.id === jobId ? prev.job : null, error: message }))
        // The job is gone or not ours -- polling again cannot help.
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) return
      }
      timer = setTimeout(tick, intervalMs)
    }
    void tick()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [jobId, intervalMs])

  const stop = useCallback(async () => {
    if (!jobId) return
    try {
      const snapshot = await stopJob<P, R>(jobId)
      if (TERMINAL_JOB_STATUSES.has(snapshot.status)) doneRef.current = true
      setSnap({ id: jobId, job: snapshot, error: null })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not reach the API.'
      setSnap((prev) => ({ id: jobId, job: prev?.id === jobId ? prev.job : null, error: message }))
    }
  }, [jobId])

  const current = snap && snap.id === jobId ? snap : null
  const job = current?.job ?? null
  const error = current?.error ?? null
  const isActive = jobId !== null && (job === null || !TERMINAL_JOB_STATUSES.has(job.status))
  return { job, error, isActive, stop }
}
