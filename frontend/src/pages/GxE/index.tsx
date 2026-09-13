// Genotype x Environment (G×E) reaction-norm study (docs/ROADMAP.md
// 2026-09-13 follow-up to Genome Stability), built on the same job-polling
// contract as Sensitivity (POST /api/gxe -> GET /api/jobs/{id}). No Stop
// button: the API has no cooperative cancellation for G×E runs (docs/API.md).
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '../../api/client'
import { startGxE } from '../../api/endpoints'
import type { EnvironmentSpec, GenotypeSpec, GxECell, GxEConfig, GxEResult, ModelConfig } from '../../api/types'
import { useBounds } from '../../api/useBounds'
import { useJob } from '../../api/useJob'
import { BaselineSummary } from '../../components/BaselineSummary'
import { Callout } from '../../components/Callout'
import { MetricRow } from '../../components/MetricRow'
import { OverrideListEditor } from '../../components/OverrideListEditor'
import { PageHeader } from '../../components/PageHeader'
import { ProgressBar } from '../../components/ProgressBar'
import { InterpretPanel } from '../../components/InterpretPanel'
import { Provenance } from '../../components/Provenance'
import { loadBaseline } from '../../components/baseline'
import { Plot } from '../../components/charts/Plot'
import { reactionNormChart } from '../../components/charts/gxeCharts'
import { usePrefersDark } from '../../components/charts/theme'
import { downloadJson, downloadText, rowsCsv } from '../../components/download'
import { GXE_DISCLAIMER, environmentOrder } from '../../components/gxeUtils'
import { parseIntList, signed } from '../../components/handoff'
import { FEATURES } from '../../features'
import { useActiveJobOfKind } from '../../jobs/useActiveJobs'

const FEATURE = FEATURES.find((f) => f.path === '/gxe')!

const DEFAULT_SEEDS = '1,2,3'

const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(4))

const cellKey = (genotype: string, environment: string) => `${genotype}::${environment}`

function defaultGenotypes(): GenotypeSpec[] {
  return [
    { name: 'genotype A', overrides: {} },
    { name: 'genotype B', overrides: {} },
  ]
}

function defaultEnvironments(): EnvironmentSpec[] {
  return [
    { name: 'environment 1', overrides: {} },
    { name: 'environment 2', overrides: {} },
  ]
}

function GxETable({ items }: { items: GxECell[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm" data-testid="gxe-table">
        <thead className="text-left text-xs text-slate-500 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2">genotype</th>
            <th className="px-3 py-2">environment</th>
            <th className="px-3 py-2 text-right">fitness</th>
            <th className="px-3 py-2 text-right">survival</th>
            <th className="px-3 py-2 text-right">senescence</th>
            <th className="px-3 py-2 text-right">canalization</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {items.map((it) => (
            <tr key={cellKey(it.genotype, it.environment)} className="border-t border-slate-200 dark:border-slate-800">
              <td className="px-3 py-1.5">{it.genotype}</td>
              <td className="px-3 py-1.5">{it.environment}</td>
              <td className="px-3 py-1.5 text-right">{it.fitness === null ? 'n/a' : signed(it.fitness, 4)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(it.survival)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(it.senescence)}</td>
              <td className="px-3 py-1.5 text-right">{fmt(it.canalization)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function GxE() {
  const { bounds, error: boundsError } = useBounds()
  const dark = usePrefersDark()

  const [genotypes, setGenotypes] = useState<GenotypeSpec[]>(defaultGenotypes())
  const [environments, setEnvironments] = useState<EnvironmentSpec[]>(defaultEnvironments())
  const [seedsText, setSeedsText] = useState(DEFAULT_SEEDS)
  const [base, setBase] = useState<ModelConfig | null>(null)
  const [notes, setNotes] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<GxEConfig | null>(null)
  const [live, setLive] = useState<GxECell[]>([])

  // Re-adopt an in-flight job of our own kind -- navigating away and back
  // must resume live progress, not reset to the idle form.
  const activeGxEJob = useActiveJobOfKind('gxe')
  const effectiveJobId = jobId ?? activeGxEJob?.job_id ?? null

  const { job, error: jobError, isActive } = useJob<GxECell, GxEResult>(effectiveJobId)

  const baseline = base ?? (bounds ? (loadBaseline() ?? bounds.demo) : null)

  // One progress payload per finished (genotype, environment) cell -> live table.
  const progress = job?.progress ?? null
  if (progress && !live.some((r) => cellKey(r.genotype, r.environment) === cellKey(progress.genotype, progress.environment))) {
    setLive([...live, progress])
  }

  const result = job?.status === 'completed' ? job.result : null
  const items = result?.items ?? live
  const environments_ = useMemo(() => environmentOrder(items), [items])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!bounds || !baseline) return
    setFormError(null)
    const seeds = parseIntList(seedsText)
    if (seeds === null) {
      setFormError('Seeds must be integers.')
      return
    }
    if (genotypes.length === 0) {
      setFormError('Add at least one genotype.')
      return
    }
    if (environments.length === 0) {
      setFormError('Add at least one environment.')
      return
    }
    const gxe: GxEConfig = {
      genotypes,
      environments,
      eval_seeds: seeds.length ? seeds : [1, 2, 3],
      weights: bounds.fitness_weights_default,
    }
    setSubmitting(true)
    try {
      const { job_id } = await startGxE({ model: baseline, gxe, notes })
      setLive([])
      setSubmitted(gxe)
      setJobId(job_id)
    } catch (err: unknown) {
      if (err instanceof ApiError) setFormError(`${err.status === 400 ? 'Invalid configuration: ' : ''}${err.message}`)
      else setFormError(err instanceof Error ? err.message : 'Could not reach the API.')
    } finally {
      setSubmitting(false)
    }
  }

  const chart = useMemo(
    () => (items.length ? reactionNormChart(items, environments_, dark) : null),
    [items, environments_, dark],
  )

  const n = (submitted?.genotypes.length ?? 0) * (submitted?.environments.length ?? 0)

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />
      <p className="text-sm leading-relaxed">
        <strong>Genotype × environment (G×E) study.</strong> Every genotype is run against every environment as an
        isolated simulation (genotypes never compete against each other) and averaged over the simulator seeds below.
        A genotype that wins in one environment but loses in another is a fitness re-ranking — the pattern this page
        is built to surface. {GXE_DISCLAIMER}
      </p>

      {boundsError && (
        <Callout tone="error" role="alert">
          Could not load parameter bounds: {boundsError}
        </Callout>
      )}
      {!bounds && !boundsError && <p className="prose-muted">Loading parameter bounds…</p>}

      {bounds && baseline && (
        <form onSubmit={onSubmit} className="space-y-6">
          <BaselineSummary bounds={bounds} value={baseline} onChange={setBase} disabled={isActive} idPrefix="gxe-base" />

          <fieldset className="card space-y-3 p-5" data-testid="genotype-editor">
            <legend className="mb-1 text-sm font-semibold">Genotypes</legend>
            <OverrideListEditor
              bounds={bounds}
              overridableParams={bounds.subclone_overridable}
              rows={genotypes}
              onChange={setGenotypes}
              disabled={isActive}
              idPrefix="gxe-genotype"
              itemLabel="genotype"
              minRows={1}
            />
          </fieldset>

          <fieldset className="card space-y-3 p-5" data-testid="environment-editor">
            <legend className="mb-1 text-sm font-semibold">Environments</legend>
            <OverrideListEditor
              bounds={bounds}
              overridableParams={bounds.environment_overridable}
              rows={environments}
              onChange={setEnvironments}
              disabled={isActive}
              idPrefix="gxe-environment"
              itemLabel="environment"
              minRows={1}
            />
          </fieldset>

          <section className="card space-y-4 p-5">
            <div>
              <label className="label" htmlFor="gxe-seeds">
                Simulator seeds to average (comma-separated)
              </label>
              <input
                id="gxe-seeds"
                className="input font-mono !text-sm"
                value={seedsText}
                disabled={isActive}
                onChange={(e) => setSeedsText(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="gxe-notes">
                Notes for the ledger
              </label>
              <input id="gxe-notes" className="input" value={notes} disabled={isActive} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </section>

          {formError && (
            <Callout tone="error" role="alert">
              {formError}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={submitting || isActive}>
              {submitting ? 'Starting…' : '🧪 Run G×E study'}
            </button>
            {isActive && (
              <span className="prose-muted text-xs">
                Runs to completion once started (the API has no stop for G×E studies).
              </span>
            )}
          </div>
        </form>
      )}

      {/* ---------------------------------------------------- live progress */}
      {effectiveJobId && isActive && (
        <section className="card space-y-3 p-5" role="status" aria-live="polite">
          {(() => {
            const rec = job?.progress ?? null
            return (
              <ProgressBar
                fraction={n > 0 ? live.length / n : 0}
                text={
                  rec
                    ? `${rec.genotype} x ${rec.environment}: fitness ${rec.fitness === null ? 'n/a' : signed(rec.fitness, 4)} (${live.length}/${n})`
                    : job?.status === 'running'
                      ? 'Evaluating…'
                      : 'Queued…'
                }
              />
            )
          })()}
          {items.length > 0 && <GxETable items={items} />}
          {jobError && (
            <Callout tone="warning" role="alert">
              Polling problem: {jobError}
            </Callout>
          )}
        </section>
      )}

      {job?.status === 'failed' && (
        <Callout tone="error" role="alert">
          The G×E job failed: {job.error ?? 'unknown error'}
        </Callout>
      )}

      {!effectiveJobId && bounds && (
        <Callout tone="info">
          Add genotypes and environments, then press <strong>Run G×E study</strong>.
        </Callout>
      )}

      {/* ----------------------------------------------------------- results */}
      {result && (
        <section className="space-y-6" aria-label="G×E results">
          <MetricRow
            metrics={[
              { label: 'Genotypes tested', value: String(submitted?.genotypes.length ?? new Set(result.items.map((it) => it.genotype)).size) },
              { label: 'Environments tested', value: String(environments_.length) },
              { label: 'Cells evaluated', value: String(result.items.length) },
              { label: 'Simulations run', value: String(result.evaluations) },
              { label: 'Runtime', value: `${result.runtime_seconds.toFixed(1)} s` },
            ]}
          />
          {result.run_id && <Provenance runId={result.run_id} />}
          {result.run_id && <InterpretPanel runId={result.run_id} />}
          {chart && <Plot figure={chart} />}

          {result.reranking_pairs.length > 0 ? (
            <Callout tone="info">
              <p>
                <strong>Genotype re-ranking detected</strong> between{' '}
                {result.reranking_pairs.map(([a, b]) => `${a} vs ${b}`).join(', ')} across environments.
              </p>
              <p className="mt-1 text-xs" data-testid="gxe-disclaimer">
                {GXE_DISCLAIMER}
              </p>
            </Callout>
          ) : (
            <Callout tone="info">
              <p>No genotype re-ranking detected across the tested environments.</p>
              <p className="mt-1 text-xs" data-testid="gxe-disclaimer">
                {GXE_DISCLAIMER}
              </p>
            </Callout>
          )}

          <div>
            <h3 className="mb-2 text-base font-semibold">G×E table</h3>
            <GxETable items={result.items} />
          </div>

          <div>
            <h3 className="mb-2 text-base font-semibold">Export</h3>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={() => downloadJson(`${result.run_id ?? 'gxe'}.json`, result)}>
                ⬇ G×E result (JSON)
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() =>
                  downloadText(
                    `${result.run_id ?? 'gxe'}.csv`,
                    rowsCsv(
                      result.items.map((it) => ({
                        genotype: it.genotype,
                        environment: it.environment,
                        fitness: it.fitness,
                        survival: it.survival,
                        senescence: it.senescence,
                        canalization: it.canalization,
                      })),
                    ),
                    'text/csv',
                  )
                }
              >
                ⬇ G×E table (CSV)
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
