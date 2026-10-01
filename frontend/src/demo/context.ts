import { createContext, useContext } from 'react'

import type { DemoScenario, DemoScenarioMeta } from './types'

export type DemoLoadStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface DemoState {
  feature: string
  /** State of the index fetch. */
  status: DemoLoadStatus
  error: string | null
  scenarios: DemoScenarioMeta[]
  selectedId: string | null
  /** The loaded scenario for `selectedId` (null while loading or on error). */
  scenario: DemoScenario | null
  scenarioStatus: 'idle' | 'loading' | 'ready' | 'error'
  select: (id: string) => void
  retry: () => void
}

/** Provided by <FeatureGate> only while a feature page is in demo mode. */
export const DemoContext = createContext<DemoState | null>(null)

/** True inside the demo gate. Forms use it to lock themselves. */
export function useIsDemo(): boolean {
  return useContext(DemoContext) !== null
}

export function useDemo(): DemoState | null {
  return useContext(DemoContext)
}

/**
 * The scenario currently shown, typed by the caller (the request/response types
 * are whatever the live endpoint takes/returns). Null in live mode and while
 * the scenario is still loading.
 */
export function useDemoScenario<Req = unknown, Res = unknown>(): DemoScenario<Req, Res> | null {
  return (useContext(DemoContext)?.scenario ?? null) as DemoScenario<Req, Res> | null
}

/** Set by <FeatureGate> so <PageHeader> knows to render the mode panel (and Docs etc. do not). */
export const GateContext = createContext(false)
