import { Fragment } from 'react'
import type { ReactNode } from 'react'

import { useAccess } from '../access/context'
import { Skeleton } from '../components/ui/Skeleton'
import { GateContext, useDemo } from './context'
import { DemoProvider } from './DemoProvider'
import { ModePanel } from './ModePanel'

/** Pages whose data loads on mount (not from page state) must wait for the scenario, then remount per scenario. */
const WAIT_FOR_SCENARIO = new Set(['experiments', 'genome'])

function Waiter({ children }: { children: ReactNode }) {
  const demo = useDemo()
  if (!demo || demo.scenarioStatus === 'ready') {
    return <Fragment key={demo?.selectedId ?? 'none'}>{children}</Fragment>
  }
  // loading / error / empty: the mode panel (rendered by the page header) is not mounted yet, so show it here.
  return <PendingScenario />
}

function PendingScenario() {
  return (
    <div className="space-y-4">
      <ModePanel />
      <Skeleton className="h-64" />
    </div>
  )
}

/**
 * Route wrapper for every compute feature. Visitors who are anonymous or on the
 * free plan get the page in demo mode (cached scenarios, locked inputs, no live
 * API); pro users and admins get it live, with a toggle to flip to demo.
 * `feature` is the demo-cache slug (index.json `features` key).
 */
export function FeatureGate({ feature, children }: { feature: string; children: ReactNode }) {
  const { status, mode } = useAccess()
  if (status === 'loading') {
    return (
      <div className="space-y-4" role="status" aria-label="Checking your session">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  return (
    <GateContext.Provider value={true}>
      <Fragment key={mode}>
        {mode === 'demo' ? (
          <DemoProvider feature={feature}>
            {WAIT_FOR_SCENARIO.has(feature) ? <Waiter>{children}</Waiter> : children}
          </DemoProvider>
        ) : (
          children
        )}
      </Fragment>
    </GateContext.Provider>
  )
}
