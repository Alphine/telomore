import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch } from '../test/helpers'
import type { JobStatusResponse } from './types'
import { useJob } from './useJob'

afterEach(() => vi.unstubAllGlobals())

function snapshot(status: JobStatusResponse['status'], extra: Partial<JobStatusResponse> = {}): JobStatusResponse {
  return {
    job_id: 'job-1',
    kind: 'evolve',
    status,
    progress: null,
    result: null,
    error: null,
    created_at: '2026-09-09T00:00:00+00:00',
    updated_at: '2026-09-09T00:00:00+00:00',
    ...extra,
  }
}

/** Serve `sequence` in order, then keep returning its last element. */
function sequenceRoute(sequence: JobStatusResponse[]) {
  let i = 0
  return () => {
    const body = sequence[Math.min(i, sequence.length - 1)]
    i += 1
    return { status: 200, body }
  }
}

describe('useJob', () => {
  it('polls until completed, then stops polling', async () => {
    const fetchMock = mockFetch({
      'GET /api/jobs/job-1': sequenceRoute([
        snapshot('pending'),
        snapshot('running', { progress: { generation: 1 } }),
        snapshot('completed', { result: { run_id: 'TEL-1' } }),
      ]),
    })
    const { result } = renderHook(() => useJob('job-1', { intervalMs: 10 }))
    expect(result.current.isActive).toBe(true)

    await waitFor(() => expect(result.current.job?.status).toBe('completed'))
    expect(result.current.isActive).toBe(false)
    expect(result.current.job?.result).toEqual({ run_id: 'TEL-1' })

    const callsAtCompletion = fetchMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 60))
    expect(fetchMock.mock.calls.length).toBe(callsAtCompletion)
    expect(callsAtCompletion).toBe(3)
  })

  it('stops polling on failed and exposes the error text', async () => {
    const fetchMock = mockFetch({
      'GET /api/jobs/job-1': sequenceRoute([snapshot('running'), snapshot('failed', { error: 'boom' })]),
    })
    const { result } = renderHook(() => useJob('job-1', { intervalMs: 10 }))
    await waitFor(() => expect(result.current.job?.status).toBe('failed'))
    expect(result.current.job?.error).toBe('boom')
    expect(result.current.isActive).toBe(false)
    const n = fetchMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock.mock.calls.length).toBe(n)
  })

  it('does nothing without a job id and cleans up on unmount', async () => {
    const fetchMock = mockFetch({ 'GET /api/jobs/job-1': sequenceRoute([snapshot('running')]) })
    const { result, unmount, rerender } = renderHook(({ id }: { id: string | null }) => useJob(id, { intervalMs: 10 }), {
      initialProps: { id: null as string | null },
    })
    expect(result.current.job).toBeNull()
    expect(result.current.isActive).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    rerender({ id: 'job-1' })
    await waitFor(() => expect(result.current.job?.status).toBe('running'))
    unmount()
    const n = fetchMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock.mock.calls.length).toBe(n)
  })

  it('stop() POSTs to /stop and adopts the returned snapshot', async () => {
    const fetchMock = mockFetch({
      'GET /api/jobs/job-1': sequenceRoute([snapshot('running')]),
      'POST /api/jobs/job-1/stop': { status: 200, body: snapshot('stopped') },
    })
    const { result } = renderHook(() => useJob('job-1', { intervalMs: 10 }))
    await waitFor(() => expect(result.current.job?.status).toBe('running'))
    await act(() => result.current.stop())
    expect(result.current.job?.status).toBe('stopped')
    const stopCall = fetchMock.mock.calls.find(([u, init]) => String(u).endsWith('/stop') && init?.method === 'POST')
    expect(stopCall).toBeTruthy()
  })
})
