// Local stand-in for the few calls a feature page makes by itself while it
// shows a cached scenario: polling the (synthetic) completed job, the
// experiments ledger and the genome explorer's data. Everything is answered
// from the loaded scenario; nothing goes to the network. A call it cannot
// answer is refused by api/client.ts with a 403 `demo_mode` error.
import { loadedScenarios } from './cache'
import type { DemoScenario } from './types'

export const DEMO_JOB_PREFIX = 'demo:'

/** The cache stores a job feature's `response` as the bare result; tolerate a whole job snapshot too. */
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

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** The toy genome is bundled in the `genome/toy-genome` scenario; any loaded one will do. */
function findGenome(current: DemoScenario | null): unknown {
  const own = rec(current?.response).genome
  if (own) return own
  for (const sc of loadedScenarios.values()) {
    const g = rec(sc.response).genome
    if (g) return g
  }
  return undefined
}

export function makeReplay(current: () => DemoScenario | null) {
  return (method: string, rawPath: string, body?: unknown): Hit => {
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

    if (path === '/sequence/genome') {
      const g = findGenome(sc)
      return g ? ok(g) : miss
    }
    if (!sc) return miss
    const res = rec(sc.response)

    if (path.startsWith('/experiments')) {
      if (path === '/experiments') return Array.isArray(sc.response) ? ok(sc.response) : miss
      const details = rec(rec(sc.extra).details)
      const art = /^\/experiments\/([^/]+)\/artifacts$/.exec(path)
      if (art) return ok([]) // artifact bundles are not part of the demo
      const one = /^\/experiments\/([^/]+)$/.exec(path)
      if (one) {
        const detail = details[decodeURIComponent(one[1])]
        return detail ? ok(detail) : miss
      }
      return miss
    }

    if (path === '/sequence/mutate' && method === 'POST') {
      // Only the mutations that were precomputed can be replayed.
      const wanted = rec(body)
      const asked = rec(sc.request).mutations
      const list = Array.isArray(asked) ? asked : []
      const idx = list.findIndex((m) => {
        const r = rec(m)
        return r.gene === wanted.gene && r.position === wanted.position && r.alt === wanted.alt
      })
      const results = res.mutations
      return idx >= 0 && Array.isArray(results) && results[idx] ? ok(results[idx]) : miss
    }
    if (path === '/sequence/lineage' && method === 'POST') {
      return 'model_bridge' in res ? ok(sc.response) : miss
    }

    const exact: Record<string, string> = { '/simulate': 'simulate', '/simulate/ensemble': 'simulate', '/compare': 'compare' }
    if (exact[path] === sc.feature && method === 'POST') return ok(sc.response)
    return miss
  }
}
