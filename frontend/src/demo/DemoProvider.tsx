import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { demoHooks } from '../api/client'
import { fetchDemoIndex, fetchDemoScenario, scenariosFor } from './cache'
import { DemoContext } from './context'
import type { DemoLoadStatus, DemoState } from './context'
import { makeReplay } from './replay'
import type { DemoScenario, DemoScenarioMeta } from './types'

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error'
}

/** Loads the demo index + the selected scenario for one feature and blocks live compute while mounted. */
export function DemoProvider({ feature, children }: { feature: string; children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  const [index, setIndex] = useState<{ status: DemoLoadStatus; error: string | null; scenarios: DemoScenarioMeta[] }>({
    status: 'loading',
    error: null,
    scenarios: [],
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scenarioState, setScenarioState] = useState<{
    id: string | null
    status: 'idle' | 'loading' | 'ready' | 'error'
    scenario: DemoScenario | null
  }>({ id: null, status: 'idle', scenario: null })

  const current = useRef<DemoScenario | null>(null)
  current.current = scenarioState.status === 'ready' ? scenarioState.scenario : null

  // While this provider is mounted nothing compute-ish may reach the live API.
  // The flag is also raised during the first render: children's mount effects
  // (which run before this component's) must already be blocked.
  useState(() => {
    demoHooks.active = true
    demoHooks.replay = makeReplay(() => current.current)
  })
  useEffect(() => {
    demoHooks.active = true
    demoHooks.replay = makeReplay(() => current.current)
    return () => {
      demoHooks.active = false
      demoHooks.replay = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setIndex({ status: 'loading', error: null, scenarios: [] })
    fetchDemoIndex()
      .then((idx) => {
        if (cancelled) return
        const scenarios = scenariosFor(idx, feature)
        setIndex({ status: scenarios.length ? 'ready' : 'empty', error: null, scenarios })
        setSelectedId((prev) => (prev && scenarios.some((s) => s.id === prev) ? prev : (scenarios[0]?.id ?? null)))
      })
      .catch((err: unknown) => {
        if (!cancelled) setIndex({ status: 'error', error: message(err), scenarios: [] })
      })
    return () => {
      cancelled = true
    }
  }, [feature, attempt])

  useEffect(() => {
    const meta = index.scenarios.find((s) => s.id === selectedId)
    if (!meta) return
    let cancelled = false
    setScenarioState({ id: meta.id, status: 'loading', scenario: null })
    fetchDemoScenario(meta)
      .then((scenario) => {
        if (!cancelled) setScenarioState({ id: meta.id, status: 'ready', scenario })
      })
      .catch(() => {
        if (!cancelled) setScenarioState({ id: meta.id, status: 'error', scenario: null })
      })
    return () => {
      cancelled = true
    }
  }, [index.scenarios, selectedId, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  const value = useMemo<DemoState>(
    () => ({
      feature,
      status: index.status,
      error: index.error,
      scenarios: index.scenarios,
      selectedId,
      scenario: scenarioState.status === 'ready' && scenarioState.id === selectedId ? scenarioState.scenario : null,
      scenarioStatus: scenarioState.id === selectedId ? scenarioState.status : 'idle',
      select: setSelectedId,
      retry,
    }),
    [feature, index, selectedId, scenarioState, retry],
  )
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>
}
