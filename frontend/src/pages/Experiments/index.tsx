// Port of app/pages/04_Experiments.py: the reproducibility ledger
// (GET /api/experiments?mine=), one record's detail (GET /api/experiments/{id})
// and its files (GET .../artifacts, .../artifacts/{name}).
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { artifactUrl, downloadArtifact, getExperiment, listArtifacts, listExperiments } from '../../api/endpoints'
import type { ArtifactInfo, ExperimentDetail, ExperimentSummary } from '../../api/types'
import { Callout } from '../../components/Callout'
import { MetricRow } from '../../components/MetricRow'
import { PageHeader } from '../../components/PageHeader'
import { downloadBlob } from '../../components/download'
import { signed } from '../../components/handoff'
import { FEATURES } from '../../features'
import { formatBytes, reproductionCommand, shortTime } from './ledger'

const FEATURE = FEATURES.find((f) => f.path === '/experiments')!

function byNewest(a: ExperimentSummary, b: ExperimentSummary): number {
  return (b.created_at ?? '').localeCompare(a.created_at ?? '')
}

export function Experiments() {
  const [params, setParams] = useSearchParams()
  const mine = params.get('mine') !== 'false'
  const selected = params.get('run')

  // Fetched state is keyed by its request (mine / run id) so switching needs
  // no reset-in-effect: a snapshot for another key is simply ignored.
  const [list, setList] = useState<{ mine: boolean; rows: ExperimentSummary[] | null; error: string | null } | null>(null)
  const [detailSnap, setDetailSnap] = useState<{
    id: string
    detail: ExperimentDetail | null
    artifacts: ArtifactInfo[] | null
    error: string | null
  } | null>(null)
  const [copied, setCopied] = useState<string | null>(null) // run id whose command was copied
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listExperiments(mine)
      .then((r) => {
        if (!cancelled) setList({ mine, rows: [...r].sort(byNewest), error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) setList({ mine, rows: null, error: err instanceof Error ? err.message : 'Could not load the ledger.' })
      })
    return () => {
      cancelled = true
    }
  }, [mine])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    Promise.all([getExperiment(selected), listArtifacts(selected)])
      .then(([d, a]) => {
        if (!cancelled) setDetailSnap({ id: selected, detail: d, artifacts: a, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setDetailSnap({ id: selected, detail: null, artifacts: null, error: err instanceof Error ? err.message : 'Could not load the run.' })
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const rows = list?.mine === mine ? list.rows : null
  const listError = list?.mine === mine ? list.error : null
  const current = selected && detailSnap?.id === selected ? detailSnap : null
  const detail = current?.detail ?? null
  const artifacts = current?.artifacts ?? null
  const detailError = current?.error ?? null

  function setTab(nextMine: boolean) {
    const next = new URLSearchParams(params)
    next.set('mine', String(nextMine))
    setParams(next)
  }

  function select(runId: string) {
    const next = new URLSearchParams(params)
    next.set('run', runId)
    setParams(next)
  }

  async function download(a: ArtifactInfo) {
    if (!selected) return
    setDownloadError(null)
    try {
      downloadBlob(a.name, await downloadArtifact(selected, a.name))
    } catch (err: unknown) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed.')
    }
  }

  async function copyCommand(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(selected)
    } catch {
      setCopied(null)
    }
  }

  const record = detail?.record ?? null
  const command = record ? reproductionCommand(record) : null

  return (
    <div className="space-y-6">
      <PageHeader feature={FEATURE} />

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist" aria-label="Ledger scope">
        {(
          [
            [true, 'My experiments'],
            [false, 'All experiments'],
          ] as Array<[boolean, string]>
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={mine === value}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              mine === value
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {listError && (
        <Callout tone="error" role="alert">
          Could not load the ledger: {listError}
        </Callout>
      )}
      {!rows && !listError && <p className="prose-muted">Loading ledger…</p>}

      {rows && rows.length === 0 && (
        <Callout tone="info">
          {mine
            ? 'You have not recorded any runs yet. Run the Simulate, Evolve, Pareto, Sensitivity or Active Learning page while logged in — every run is recorded.'
            : 'No runs recorded yet. Run the Simulate or Evolve page, or use the CLI scripts.'}
        </Callout>
      )}

      {rows && rows.length > 0 && (
        <div className="card max-h-[26rem] overflow-auto">
          <table className="w-full text-sm" data-testid="ledger-table">
            <thead className="sticky top-0 bg-white text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">run id</th>
                <th className="px-3 py-2">timestamp</th>
                <th className="px-3 py-2">kind</th>
                <th className="px-3 py-2 text-right">seed</th>
                <th className="px-3 py-2">config hash</th>
                <th className="px-3 py-2 text-right">fitness</th>
                <th className="px-3 py-2">git commit</th>
                <th className="px-3 py-2">notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.run_id}
                  className={`cursor-pointer border-t border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60 ${
                    r.run_id === selected ? 'bg-teal-50 dark:bg-teal-500/10' : ''
                  }`}
                  onClick={() => select(r.run_id)}
                >
                  <td className="px-3 py-1.5">
                    <button type="button" className="link font-mono" onClick={() => select(r.run_id)}>
                      {r.run_id}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{shortTime(r.created_at)}</td>
                  <td className="px-3 py-1.5">{r.kind ?? ''}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.seed ?? ''}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.configuration_hash ?? ''}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.fitness === null ? 'n/a' : signed(r.fitness, 4)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.git_commit ?? 'n/a'}</td>
                  <td className="px-3 py-1.5 text-xs">{r.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && (
        <p className="prose-muted text-xs">
          {rows.length} run(s){mine ? ' recorded by you' : ' in the shared ledger'}. Click a row to inspect it.
        </p>
      )}

      {/* ------------------------------------------------------------ detail */}
      {selected && (
        <section className="space-y-4" aria-label="Run detail">
          <h2 className="text-lg font-semibold">
            Inspect <code className="font-mono">{selected}</code>
          </h2>
          {detailError && (
            <Callout tone="error" role="alert">
              {detailError}
            </Callout>
          )}
          {!detail && !detailError && <p className="prose-muted">Loading run…</p>}

          {record && (
            <>
              <MetricRow
                metrics={[
                  { label: 'Kind', value: record.kind },
                  { label: 'Seed', value: String(record.seed) },
                  { label: 'Fitness', value: record.fitness === null || record.fitness === undefined ? 'n/a' : signed(record.fitness, 4) },
                  { label: 'Git commit', value: record.git_commit ?? 'n/a' },
                  { label: 'Config hash', value: record.configuration_hash },
                  { label: 'Recorded', value: shortTime(record.created_at) },
                ]}
              />

              {command && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-base font-semibold">Reproduce</h3>
                    <button type="button" className="btn-ghost !px-3 !py-1" onClick={() => void copyCommand(command)}>
                      {copied === selected ? '✓ Copied' : 'Copy command'}
                    </button>
                  </div>
                  <pre className="mono-block whitespace-pre-wrap text-xs" data-testid="reproduce-command">
                    {command}
                  </pre>
                </div>
              )}

              <div>
                <h3 className="mb-1 text-base font-semibold">Artifacts</h3>
                {artifacts && artifacts.length === 0 && <p className="prose-muted text-sm">No files in this run's directory.</p>}
                {artifacts && artifacts.length > 0 && (
                  <ul className="card divide-y divide-slate-200 text-sm dark:divide-slate-800" data-testid="artifact-list">
                    {artifacts.map((a) => (
                      <li key={a.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                        <span>
                          <a
                            className="link font-mono"
                            href={artifactUrl(selected, a.name)}
                            download={a.name}
                            onClick={(e) => {
                              // The API route needs the bearer token, which a plain link cannot send.
                              e.preventDefault()
                              void download(a)
                            }}
                          >
                            ⬇ {a.name}
                          </a>
                          {a.key && <span className="prose-muted ml-2 text-xs">{a.key}</span>}
                        </span>
                        <span className="prose-muted font-mono text-xs">
                          {a.media_type} · {formatBytes(a.size_bytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {downloadError && (
                  <Callout tone="error" role="alert">
                    Download failed: {downloadError}
                  </Callout>
                )}
              </div>

              <details className="card p-5">
                <summary className="cursor-pointer select-none text-sm font-semibold">Full record (JSON)</summary>
                <pre className="mono-block mt-3 text-xs">{JSON.stringify(record, null, 2)}</pre>
              </details>
            </>
          )}
        </section>
      )}
    </div>
  )
}
