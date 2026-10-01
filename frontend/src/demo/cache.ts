// Fetching and memoising the static demo cache. Failures are never cached, so
// a flaky network (or a deploy that has not shipped the cache yet) can be
// retried from the UI without a reload.
import type { DemoIndex, DemoScenario, DemoScenarioMeta } from './types'

export function demoUrl(file: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  return `${base}demo-cache/${file.replace(/^\/+/, '')}`
}

let indexPromise: Promise<DemoIndex> | null = null
const scenarioPromises = new Map<string, Promise<DemoScenario>>()
/** Scenarios already fetched, by id: the job-poll replay reads from here synchronously. */
export const loadedScenarios = new Map<string, DemoScenario>()

/** Test hook. */
export function resetDemoCache(): void {
  indexPromise = null
  scenarioPromises.clear()
  loadedScenarios.clear()
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`)
  return res.json()
}

export function fetchDemoIndex(): Promise<DemoIndex> {
  if (!indexPromise) {
    indexPromise = getJson(demoUrl('index.json'))
      .then((raw) => {
        const idx = raw as Partial<DemoIndex> | null
        if (!idx || typeof idx !== 'object' || !idx.features || typeof idx.features !== 'object') {
          throw new Error('The demo index is malformed.')
        }
        return idx as DemoIndex
      })
      .catch((err: unknown) => {
        indexPromise = null
        throw err
      })
  }
  return indexPromise
}

export function fetchDemoScenario(meta: DemoScenarioMeta): Promise<DemoScenario> {
  let p = scenarioPromises.get(meta.id)
  if (!p) {
    const v = meta.version ?? meta.sha?.slice(0, 10)
    p = getJson(demoUrl(meta.file) + (v ? `?v=${v}` : ''))
      .then((raw) => {
        const sc = raw as Partial<DemoScenario> | null
        if (!sc || typeof sc !== 'object' || !('response' in sc)) throw new Error('The demo scenario is malformed.')
        const full: DemoScenario = {
          id: sc.id ?? meta.id,
          title: sc.title ?? meta.title,
          description: sc.description ?? meta.description,
          feature: sc.feature ?? '',
          request: sc.request ?? null,
          response: sc.response,
          endpoint: sc.endpoint ?? meta.endpoint,
          meta: sc.meta,
          extra: sc.extra,
        }
        loadedScenarios.set(meta.id, full)
        return full
      })
      .catch((err: unknown) => {
        scenarioPromises.delete(meta.id)
        throw err
      })
    scenarioPromises.set(meta.id, p)
  }
  return p
}

/** Route slug -> the scenarios the index lists for it (tolerates `-`/`_` spelling differences). */
export function scenariosFor(index: DemoIndex, slug: string): DemoScenarioMeta[] {
  const variants = [slug, slug.replace(/-/g, '_'), slug.replace(/_/g, '-')]
  for (const v of variants) {
    const list = index.features[v]
    if (Array.isArray(list)) return list
  }
  return []
}
