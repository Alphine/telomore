import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { getExperiment } from '../api/endpoints'
import type { ExperimentRecord } from '../api/types'
import { Callout } from './Callout'

/**
 * "Recorded as <run_id> · config hash <hash>" (the st.success line every
 * Streamlit optimizer page showed). Job results carry only the run_id, so the
 * configuration hash / git commit are read from GET /api/experiments/{run_id};
 * if that lookup fails the run id alone is shown.
 */
export function Provenance({ runId }: { runId: string }) {
  // Keyed by run id so a new run needs no reset-in-effect.
  const [loaded, setLoaded] = useState<{ id: string; record: ExperimentRecord } | null>(null)

  useEffect(() => {
    let cancelled = false
    getExperiment(runId)
      .then((d) => {
        if (!cancelled) setLoaded({ id: runId, record: d.record })
      })
      .catch(() => {
        /* the run id is still worth showing */
      })
    return () => {
      cancelled = true
    }
  }, [runId])

  const record = loaded?.id === runId ? loaded.record : null

  return (
    <Callout tone="success">
      <span data-testid="provenance">
        Recorded as{' '}
        <Link className="link font-mono" to={`/experiments?run=${encodeURIComponent(runId)}`}>
          {runId}
        </Link>{' '}
        in the experiment ledger
        {record && (
          <>
            {' '}
            · config hash <code className="font-mono text-xs">{record.configuration_hash}</code>
            {record.git_commit && (
              <>
                {' '}
                · commit <code className="font-mono text-xs">{record.git_commit}</code>
              </>
            )}
          </>
        )}
        .
      </span>
    </Callout>
  )
}
