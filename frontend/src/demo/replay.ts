// Local stand-in for the few read calls a feature page makes by itself while it
// shows a cached scenario: polling the (synthetic) completed job, the
// experiments ledger and the genome explorer's data. Everything is answered
// from the loaded scenario; nothing goes to the network.
import { loadedScenarios } from './cache'
import type { DemoScenario } from './types'

export const DEMO_JOB_PREFIX = 'demo:'

/** The cache stores a job feature's `response` either as the bare result or as a whole job snapshot. */
export function jobResult(response: unknown): unknown {
  if (response && typeof response === 'object' && 'status' in response && 'result' in response) {
    return (response as { result: unknown }).result
  }
  return response
}

export function syntheticJob(scenarioId: string, feature: string, response: unknown) {
  const now = new Date().toISOString()
  return {
    job_id: `${DEMO_JOB_PREFIX}${scenarioId}`,
    kind: feature.replace(/-/g, '_'),
    status: 'completed',
    progress: null,
    result: jobResult(response),
    error: null,
    created_at: now,
    updated_at: now,
  }
}

type Hit = { hit: true; value: unknown } | { hit: false }
const miss: Hit = { hit: false }
const ok = (value: unknown): Hit => ({ hit: true, value })

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function makeReplay(current: () => DemoScenario | null) {
  return (method: string, rawPath: string): Hit => {
    const path = rawPath.split('?')[0]
    const sc = current()
    if (path === '/jobs') return ok([])

    const job = /^\/jobs\/(.+)$/.exec(path)
    if (job) {
      const id = decodeURIComponent(job[1])
      if (!id.startsWith(DEMO_JOB_PREFIX)) return miss
      const target = loadedScenarios.get(id.slice(DEMO_JOB_PREFIX.length)) ?? sc
      return target ? ok(syntheticJob(target.id, target.feature, target.response)) : miss
    }
    if (!sc) return miss
    const res = asRecord(sc.response)

    if (sc.feature === 'experiments' || path.startsWith('/experiments')) {
      if (path === '/experiments') {
        const list = Array.isArray(sc.response) ? sc.response : (res.experiments ?? res.items)
        return Array.isArray(list) ? ok(list) : miss
      }
      const art = /^\/experiments\/([^/]+)\/artifacts$/.exec(path)
      if (art) return ok(asRecord(res.artifacts)[decodeURIComponent(art[1])] ?? [])
      const one = /^\/experiments\/([^/]+)$/.exec(path)
      if (one) {
        const id = decodeURIComponent(one[1])
        const detail = asRecord(res.details)[id]
        if (detail) return ok(detail)
        const list = Array.isArray(sc.response) ? sc.response : (res.experiments ?? res.items)
        const row = Array.isArray(list) ? list.find((r) => asRecord(r).run_id === id) : undefined
        return row ? ok(row) : miss
      }
      return miss
    }

    if (sc.feature === 'genome' || path.startsWith('/sequence')) {
      if (path === '/sequence/genome') return res.genome || asRecord(sc.meta).genome ? ok(res.genome ?? asRecord(sc.meta).genome) : miss
      if (path === '/sequence/lineage') return ok(res.lineage ?? sc.response)
      if (path === '/sequence/mutate') return method === 'POST' && res.mutation ? ok(res.mutation) : miss
      return miss
    }

    const exact: Record<string, string> = {
      '/simulate': 'simulate',
      '/simulate/ensemble': 'simulate',
      '/compare': 'compare',
    }
    if (exact[path] === sc.feature && method === 'POST') return ok(sc.response)
    return miss
  }
}
