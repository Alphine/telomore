// Toy DNA -> RNA -> protein explorer + normal-vs-damaged lineage comparison
// (docs/MODEL.md §2.4, POST /api/sequence/*). Synthetic genes; a teaching
// model, not a biological claim.
import { useEffect, useMemo, useState } from 'react'
import type { Data } from 'plotly.js-dist-min'

import { ApiError } from '../../api/client'
import { getToyGenome, mutateGene, runLineage } from '../../api/endpoints'
import type { LineageResponse, MutateResponse, ToyGene, ToyGenomeResponse } from '../../api/types'
import { Callout } from '../../components/Callout'
import { NumberInput } from '../../components/NumberInput'
import { PageHeader } from '../../components/PageHeader'
import { Plot } from '../../components/charts/Plot'
import { PALETTE, baseLayout, usePrefersDark } from '../../components/charts/theme'
import { FEATURES } from '../../features'
import { usePersistentState } from '../../state/usePersistentState'

const FEATURE = FEATURES.find((f) => f.path === '/genome')!
const BASES = ['A', 'C', 'G', 'T']

const EFFECT_TONE: Record<string, string> = {
  synonymous: 'text-emerald-600 dark:text-emerald-400',
  missense: 'text-amber-600 dark:text-amber-400',
  nonsense: 'text-red-600 dark:text-red-400',
  start_loss: 'text-red-600 dark:text-red-400',
  stop_loss: 'text-red-600 dark:text-red-400',
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Request failed.'
}

function GeneViewer({ gene }: { gene: ToyGene }) {
  const [pos, setPos] = useState<number | null>(null)
  const [result, setResult] = useState<MutateResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const codons = useMemo(
    () => Array.from({ length: gene.dna.length / 3 }, (_, i) => gene.dna.slice(3 * i, 3 * i + 3)),
    [gene],
  )

  async function apply(alt: string) {
    if (pos === null) return
    setError(null)
    try {
      setResult(await mutateGene({ gene: gene.name, position: pos, alt }))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        <strong>{gene.name}</strong> — role: <em>{gene.role}</em>. Click a base, then choose its replacement.
      </p>
      <div className="card max-h-64 overflow-auto p-3 font-mono text-sm" data-testid="codon-grid">
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {codons.map((codon, ci) => (
            <span key={ci} className="inline-flex flex-col items-center">
              <span className="flex">
                {codon.split('').map((b, k) => {
                  const p = 3 * ci + k
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-label={`base ${p} ${b}`}
                      onClick={() => setPos(p)}
                      className={`rounded px-0.5 ${pos === p ? 'bg-teal-500 text-white' : 'hover:bg-slate-200 dark:hover:bg-slate-700'}`}
                    >
                      {b}
                    </button>
                  )
                })}
              </span>
              <span className="text-[10px] text-slate-500">{gene.protein[ci] ?? '■'}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Replace base {pos === null ? '—' : `#${pos} (${gene.dna[pos]})`} with</span>
        {BASES.map((b) => (
          <button
            key={b}
            type="button"
            className="btn-ghost !px-3 !py-1 !text-xs"
            disabled={pos === null || gene.dna[pos] === b}
            onClick={() => apply(b)}
          >
            {b}
          </button>
        ))}
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      {result && (
        <div className="card p-3 text-sm" data-testid="mutation-result">
          <p>
            codon {result.codon_index}: <code>{result.ref_codon}</code> → <code>{result.alt_codon}</code> ({result.ref_aa} →{' '}
            {result.alt_aa}) — <strong className={EFFECT_TONE[result.effect]}>{result.effect.replace('_', ' ')}</strong>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            protein: {result.mutated_protein.length} aa (was {gene.protein.length} aa)
          </p>
        </div>
      )}
    </div>
  )
}

function lineageFigure(res: LineageResponse, key: string, dark: boolean, title: string, yTitle: string) {
  const data: Data[] = (['normal', 'damaged'] as const).map((k, i) => ({
    type: 'scatter',
    mode: 'lines',
    name: k,
    x: res[k].generation,
    y: res[k][key] as Array<number | null>,
    line: { color: PALETTE[i], width: 2 },
  }))
  return { data, layout: baseLayout({ dark, title, xTitle: 'generation', yTitle, height: 300 }) }
}

export function GenomeExplorer() {
  const dark = usePrefersDark()
  const [genome, setGenome] = usePersistentState<ToyGenomeResponse | null>('genomeexplorer:genome', null)
  const [active, setActive] = usePersistentState('genomeexplorer:active', 0)
  const [error, setError] = useState<string | null>(null)
  const [rate, setRate] = usePersistentState('genomeexplorer:rate', 2e-4)
  const [gens, setGens] = usePersistentState('genomeexplorer:gens', 60)
  const [busy, setBusy] = useState(false)
  const [lineage, setLineage] = usePersistentState<LineageResponse | null>('genomeexplorer:lineage', null)

  useEffect(() => {
    getToyGenome()
      .then(setGenome)
      .catch((e) => setError(errMsg(e)))
  }, [])

  async function onRun() {
    setBusy(true)
    setError(null)
    try {
      setLineage(await runLineage({ mutation_rate: rate, generations: gens }))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const gene = genome?.genes[active]
  const charts: Array<[string, string, string, string]> = [
    ['mean_burden', 'Mean passenger burden', 'mutations / cell', 'burden'],
    ['alive_fraction', 'Cells surviving each generation', 'fraction', 'alive'],
    ['TOY-CHK_functional', 'Checkpoint (TOY-CHK) intact', 'fraction of cells', 'chk'],
    ['TOY-REP_functional', 'Repair (TOY-REP) intact', 'fraction of cells', 'rep'],
  ]

  return (
    <div className="space-y-8">
      <PageHeader feature={FEATURE} />
      <Callout tone="info">
        Toy model: the genetic code is the real standard one, but the three genes are synthetic and their roles
        (checkpoint / repair / essential) are labels chosen to illustrate the model — not real human genes.
      </Callout>
      {error && <Callout tone="error">{error}</Callout>}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">1. DNA → RNA → protein</h2>
        {!genome && !error && <p className="text-sm text-slate-500">Loading genome…</p>}
        {genome && gene && (
          <>
            <div className="flex gap-2" role="tablist">
              {genome.genes.map((g, i) => (
                <button
                  key={g.name}
                  role="tab"
                  aria-selected={i === active}
                  className={i === active ? 'btn-primary !px-3 !py-1 !text-xs' : 'btn-ghost !px-3 !py-1 !text-xs'}
                  onClick={() => setActive(i)}
                >
                  {g.name}
                </button>
              ))}
            </div>
            <GeneViewer key={gene.name} gene={gene} />
            <p className="text-xs text-slate-500">
              Share of all single-base substitutions:{' '}
              {Object.entries(gene.profile)
                .map(([k, v]) => `${k.replace('_', ' ')} ${(v * 100).toFixed(1)}%`)
                .join(' · ')}
            </p>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">2. Normal vs damaged lineage</h2>
        <p className="prose-muted max-w-2xl text-sm">
          The <em>damaged</em> lineage starts with TOY-CHK and TOY-REP already lost: no apoptosis checkpoint and a
          10× mutation rate. Mutations are drawn from each gene's real substitution table.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label" htmlFor="gx-rate">
              Mutation rate / base / division
            </label>
            <NumberInput id="gx-rate" value={rate} onChange={setRate} min={0} max={0.01} step={0.00005} />
          </div>
          <div>
            <label className="label" htmlFor="gx-gens">
              Generations
            </label>
            <NumberInput id="gx-gens" value={gens} onChange={setGens} min={1} max={200} step={1} />
          </div>
          <button type="button" className="btn-primary" onClick={onRun} disabled={busy}>
            {busy ? 'Running…' : 'Run lineages'}
          </button>
        </div>
        {lineage && (
          <div className="grid gap-4 md:grid-cols-2" data-testid="lineage-charts">
            {charts.map(([key, title, yTitle, label]) => (
              <Plot key={key} figure={lineageFigure(lineage, key, dark, title, yTitle)} ariaLabel={label} />
            ))}
          </div>
        )}
        {lineage && (
          <p className="text-xs text-slate-500">
            Bridge to the cell-population model: damaged ⇒ checkpoint_strength{' '}
            {lineage.model_bridge.damaged.checkpoint_strength}, replication_error_rate{' '}
            {lineage.model_bridge.damaged.replication_error_rate} (see the healthy-vs-damaged preset on Simulate).
          </p>
        )}
      </section>
    </div>
  )
}
