import { useEffect, useMemo, useState } from 'react'
import type { SVGProps } from 'react'
import { Link } from 'react-router-dom'

import { Disclaimer } from '../components/Callout'
import {
  BarsIcon,
  CheckIcon,
  ChipIcon,
  ChromosomeDotIcon,
  FEATURE_ICONS,
  LedgerIcon,
  LightbulbIcon,
  LogoMark,
  RefreshIcon,
  ScaleIcon,
  ScatterIcon,
  TargetIcon,
} from '../components/icons'
import { ThemeToggle } from '../components/ThemeToggle'
import { FEATURES } from '../features'

// Pre-login "show off" page (2026-09-16, restyled 2026-09-18 to the
// dark-neon-DNA direction explored in the /design canvas): a standalone,
// full-bleed marketing page shown to anonymous visitors at "/" instead of
// the sidebar-wrapped Landing dashboard (pages/Home.tsx picks between the
// two by auth status). Uses the app's real light/dark toggle (ThemeToggle,
// the `.dark` class) rather than a page-local theme mechanism -- one theme
// switch for the whole app, not two competing ones.
// Every number here mirrors Landing.tsx's own "counted, not guessed"
// discipline and every "Results" claim is a real, reproducible finding
// cited to its docs/EXPERIMENT_PROTOCOL.md section -- not a fabricated
// case study.

type Icon = (props: SVGProps<SVGSVGElement>) => JSX.Element

const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-slate-950 ' +
  'bg-gradient-to-r from-cyan-400 to-sky-400 transition hover:-translate-y-px ' +
  'hover:shadow-[0_10px_28px_-8px_rgba(34,211,238,0.55)]'
const btnPrimarySm = btnPrimary.replace('px-6 py-3 text-sm', 'px-4 py-2 text-[13px]')
const btnGhost =
  'inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition ' +
  'border border-slate-300 text-slate-800 hover:bg-slate-100 ' +
  'dark:border-white/15 dark:text-slate-50 dark:hover:bg-white/10'
const btnGhostSm = btnGhost.replace('px-6 py-3 text-sm', 'px-4 py-2 text-[13px]')

const card =
  'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition ' +
  'hover:-translate-y-0.5 hover:shadow-md hover:border-cyan-300 ' +
  'dark:border-white/10 dark:bg-white/[0.03] dark:shadow-none dark:hover:border-cyan-400/40'

const TINTS = {
  cyan: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  pink: 'bg-pink-50 text-pink-700 dark:bg-pink-500/10 dark:text-pink-300',
} as const

const STATS: { icon: Icon; value: string; label: string }[] = [
  { icon: CheckIcon, value: '489', label: 'automated tests (313 backend + 176 frontend)' },
  { icon: ScatterIcon, value: `${FEATURES.length}`, label: 'lab tools' },
  { icon: LedgerIcon, value: '10', label: 'documented experiments' },
  { icon: ChipIcon, value: 'CPU-only', label: 'no GPU required' },
]

const FLOW: { icon: Icon; title: string; sub: string }[] = [
  { icon: LightbulbIcon, title: 'Hypothesis', sub: 'a biological question & objective' },
  { icon: FEATURE_ICONS['/evolve'], title: 'Parameter genome', sub: 'stress, maintenance, repair, ...' },
  { icon: FEATURE_ICONS['/simulate'], title: 'Simulation', sub: 'population × telomeres, per cycle' },
  { icon: BarsIcon, title: 'Biological outcomes', sub: 'length, senescence, survival' },
  { icon: TargetIcon, title: 'Fitness score', sub: 'explicit weighted objective' },
  { icon: RefreshIcon, title: 'Selection', sub: 'mutate & seed next generation' },
]

const PILLARS: { icon: Icon; tint: keyof typeof TINTS; title: string; desc: string; path: string }[] = [
  { icon: FEATURE_ICONS['/simulate'], tint: 'cyan', title: 'Telomere Dynamics', desc: 'Model shortening, maintenance and biological trade-offs across a dividing cell population.', path: '/simulate' },
  { icon: FEATURE_ICONS['/evolve'], tint: 'violet', title: 'Evolutionary Search', desc: 'A genetic algorithm searches parameter conditions for the objective you define.', path: '/evolve' },
  { icon: FEATURE_ICONS['/pareto'], tint: 'pink', title: 'Pareto Analysis', desc: 'See the full trade-off surface between survival, reproduction and maintenance cost.', path: '/pareto' },
  { icon: LedgerIcon, tint: 'cyan', title: 'Data Driven', desc: 'Every run is written to a reproducibility ledger you can browse and re-run.', path: '/experiments' },
]

interface Individual {
  id: number
  color: 'cyan' | 'pink'
  length: string
  fitness: string
  age: number
  strategy: string
  sparkline: string
}

const STRATEGIES = ['High maintenance', 'High repair', 'Balanced', 'Low investment', 'Stress-tolerant']

function buildIndividuals(): Individual[] {
  const out: Individual[] = []
  for (let i = 0; i < 60; i++) {
    const seed = (i * 37 + 11) % 97
    const pts: string[] = []
    let y = 8 + (seed % 10)
    for (let p = 0; p < 8; p++) {
      y = Math.min(38, Math.max(4, y + ((seed + p * 13) % 7) - 2))
      pts.push(`${p * 21},${y}`)
    }
    out.push({
      id: i + 1,
      color: i % 2 === 0 ? 'cyan' : 'pink',
      length: (3 + (seed % 50) / 10).toFixed(1),
      fitness: (0.4 + (seed % 55) / 100).toFixed(2),
      age: 1500 + seed * 80,
      strategy: STRATEGIES[i % STRATEGIES.length],
      sparkline: pts.join(' '),
    })
  }
  return out
}

function Navbar() {
  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-white/10 dark:bg-slate-950/80">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark className="h-7 w-7 shrink-0" />
          <div className="hidden sm:block">
            <div className="font-heading truncate text-[15px] font-bold text-slate-900 dark:text-slate-50">
              Telomere Evolution Lab
            </div>
            <div className="text-[10.5px] tracking-wide text-slate-500 dark:text-slate-500">
              Simulate &middot; Evolve &middot; Compare
            </div>
          </div>
        </div>
        <nav className="hidden items-center gap-7 md:flex" aria-label="Page sections">
          <a href="#features" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            Features
          </a>
          <a href="#simulation" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            Simulation
          </a>
          <a href="#results" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            Results
          </a>
          <a
            href="/demo.html"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            Demo
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link to="/login" className={btnGhostSm}>
            Log in
          </Link>
          <Link to="/register" className={btnPrimarySm}>
            Open Lab &rarr;
          </Link>
        </div>
      </div>
    </div>
  )
}

function HeroArt() {
  return (
    <div className="relative h-[420px] sm:h-[460px]">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-14 opacity-0 blur-[2px] transition-opacity dark:opacity-100"
        style={{
          background:
            'radial-gradient(340px 340px at 30% 35%, rgba(34,211,238,0.30), transparent 65%),' +
            'radial-gradient(280px 260px at 55% 15%, rgba(168,85,247,0.24), transparent 68%),' +
            'radial-gradient(300px 300px at 78% 60%, rgba(236,72,153,0.26), transparent 65%)',
        }}
      />
      <svg viewBox="0 0 420 460" fill="none" className="relative z-10 h-full w-full">
        <defs>
          <linearGradient id="showcase-helix" x1="0" y1="0" x2="0" y2="460">
            <stop stopColor="#22d3ee" />
            <stop offset="1" stopColor="#38bdf8" />
          </linearGradient>
          <linearGradient id="showcase-chr" x1="0" y1="0" x2="180" y2="180">
            <stop stopColor="#ec4899" />
            <stop offset="1" stopColor="#a855f7" />
          </linearGradient>
          <filter id="showcase-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#showcase-glow)">
          <path d="M70 10c60 45 60 90 0 135s-60 90 0 135 60 90 0 135" stroke="url(#showcase-helix)" strokeWidth={4} fill="none" strokeLinecap="round" />
          <path d="M150 10c-60 45-60 90 0 135s60 90 0 135-60 90 0 135" stroke="url(#showcase-helix)" strokeWidth={4} fill="none" strokeLinecap="round" />
          {[45, 110, 180, 250, 315].map((y) => (
            <line key={y} x1="72" y1={y} x2="148" y2={y} stroke="url(#showcase-helix)" strokeWidth={2.4} opacity={0.8} />
          ))}
          <circle cx="70" cy="10" r="7" fill="url(#showcase-helix)" />
          <circle cx="150" cy="10" r="7" fill="url(#showcase-helix)" />
          <circle cx="70" cy="415" r="7" fill="url(#showcase-helix)" />
          <circle cx="150" cy="415" r="7" fill="url(#showcase-helix)" />
        </g>
        <g filter="url(#showcase-glow)" transform="translate(230,140)">
          <path d="M40 0c22 22 22 44 0 66s-22 44 0 66" stroke="url(#showcase-chr)" strokeWidth={17} fill="none" strokeLinecap="round" />
          <path d="M110 0c-22 22-22 44 0 66s22 44 0 66" stroke="url(#showcase-chr)" strokeWidth={17} fill="none" strokeLinecap="round" />
          <circle cx="40" cy="0" r="9.5" fill="#fb7185" />
          <circle cx="110" cy="0" r="9.5" fill="#fb7185" />
          <circle cx="40" cy="132" r="9.5" fill="#fb7185" />
          <circle cx="110" cy="132" r="9.5" fill="#fb7185" />
        </g>
      </svg>
      <div className="absolute top-[5%] left-[5%] max-w-[150px] text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
        <div className="font-heading mb-0.5 text-[11px] font-bold tracking-wide text-slate-900 dark:text-slate-100">DNA</div>
        The blueprint of life, shaped by evolution.
      </div>
      <div className="absolute top-[3%] right-[3%] max-w-[150px] text-right text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
        <div className="font-heading mb-0.5 text-[11px] font-bold tracking-wide text-slate-900 dark:text-slate-100">TELOMERE</div>
        Protects genetic information, but gets shorter over time.
      </div>
    </div>
  )
}

function LiveSimulationPreview() {
  const individuals = useMemo(() => buildIndividuals(), [])
  const [selectedId, setSelectedId] = useState(24)
  const [generation, setGeneration] = useState(8420)
  const [playing, setPlaying] = useState(false)
  const [maintenance, setMaintenance] = useState(60)
  const [replication, setReplication] = useState(70)
  const [mutation, setMutation] = useState(20)
  const [stress, setStress] = useState(50)
  const [objective, setObjective] = useState<'longevity' | 'reproduction' | 'balanced'>('longevity')
  const [queued, setQueued] = useState(false)

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setGeneration((g) => {
        const next = g + 60
        if (next >= 10000) {
          setPlaying(false)
          return 10000
        }
        return next
      })
    }, 120)
    return () => clearInterval(id)
  }, [playing])

  const selected = individuals.find((i) => i.id === selectedId) ?? individuals[0]

  const objectives: { key: typeof objective; label: string }[] = [
    { key: 'longevity', label: 'Longevity' },
    { key: 'reproduction', label: 'Reproduction' },
    { key: 'balanced', label: 'Balanced' },
  ]

  return (
    <div className={`${card} hover:translate-y-0`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="font-heading flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-50">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_theme(colors.emerald.500)]" />
          Live Simulation Preview
        </div>
        <div className="flex gap-2">
          <span className="rounded-full border border-slate-200 px-2.5 py-1 font-mono text-[11px] text-slate-500 dark:border-white/10 dark:text-slate-400">
            Generation {generation.toLocaleString()}
          </span>
          <span className="rounded-full border border-slate-200 px-2.5 py-1 font-mono text-[11px] text-slate-500 dark:border-white/10 dark:text-slate-400">
            Population 60
          </span>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="grid gap-4 sm:grid-cols-[1fr_170px]">
          <div className="grid grid-cols-10 content-start gap-1.5 sm:grid-cols-10">
            {individuals.map((ind) => (
              <button
                key={ind.id}
                type="button"
                title={`Individual ${ind.id}`}
                onClick={() => setSelectedId(ind.id)}
                className={[
                  'flex items-center justify-center rounded-md border p-0.5 transition',
                  ind.id === selectedId
                    ? 'border-cyan-400 bg-cyan-50 dark:bg-cyan-400/10'
                    : 'border-transparent hover:border-slate-300 dark:hover:border-white/20',
                ].join(' ')}
              >
                <ChromosomeDotIcon
                  className={`h-4 w-4 ${ind.color === 'cyan' ? 'text-cyan-500 dark:text-cyan-400' : 'text-pink-500 dark:text-pink-400'}`}
                />
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 dark:border-white/10 dark:bg-white/[0.02]">
            <div className="mb-2.5 text-[10.5px] font-bold tracking-wide text-slate-500 uppercase dark:text-slate-500">
              Selected #{selected.id}
            </div>
            {[
              ['Telomere length', `${selected.length} kb`],
              ['Fitness score', selected.fitness],
              ['Age (generations)', selected.age.toLocaleString()],
              ['Strategy', selected.strategy],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between border-b border-dashed border-slate-200 py-1 text-[12px] text-slate-500 last:border-0 dark:border-white/10 dark:text-slate-400"
              >
                <span>{label}</span>
                <span className="font-heading font-bold text-slate-900 dark:text-slate-50">{value}</span>
              </div>
            ))}
            <svg viewBox="0 0 150 44" className="mt-2.5 h-11 w-full">
              <polyline
                points={selected.sparkline}
                fill="none"
                className="stroke-cyan-600 dark:stroke-cyan-400"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.02]">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-heading text-[13px] font-semibold text-slate-900 dark:text-slate-50">Adjust Parameters</span>
            <button
              type="button"
              onClick={() => {
                setMaintenance(60)
                setReplication(70)
                setMutation(20)
                setStress(50)
              }}
              className="text-[11.5px] text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              Reset
            </button>
          </div>

          {[
            { label: 'Maintenance investment', value: maintenance, set: setMaintenance },
            { label: 'Replication pressure', value: replication, set: setReplication },
            { label: 'Mutation rate', value: mutation, set: setMutation },
            { label: 'Environmental stress', value: stress, set: setStress },
          ].map((p) => (
            <div key={p.label} className="mb-3.5">
              <div className="mb-1.5 flex items-baseline justify-between text-[12px] text-slate-700 dark:text-slate-300">
                <span>{p.label}</span>
                <span className="font-mono text-[11.5px] text-cyan-700 dark:text-cyan-400">{(p.value / 100).toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={p.value}
                onChange={(e) => p.set(Number(e.target.value))}
                className="w-full accent-cyan-600 dark:accent-cyan-400"
              />
            </div>
          ))}

          <div className="mt-3.5 mb-4 flex flex-wrap gap-2">
            {objectives.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setObjective(o.key)}
                className={[
                  'flex-1 rounded-lg border px-1.5 py-2 text-[11.5px] font-semibold transition',
                  objective === o.key
                    ? 'border-cyan-400 bg-cyan-400 text-slate-950'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-400 dark:hover:bg-white/5',
                ].join(' ')}
              >
                {o.label}
              </button>
            ))}
          </div>

          <button type="button" className={`${btnPrimary} w-full !rounded-lg`} onClick={() => setQueued(true)}>
            Run Experiment &rarr;
          </button>
          {queued && (
            <p className="mt-2.5 text-center text-[11px] text-emerald-600 dark:text-emerald-400">
              Queued (preview) &mdash; log in to run it for real.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPlaying((v) => !v)}
          aria-label="Play or pause"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-400 text-slate-950"
        >
          {playing ? (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <rect x="4" y="3" width="4" height="14" rx="1" />
              <rect x="12" y="3" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M5 3.5v13l12-6.5z" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={10000}
          value={generation}
          onChange={(e) => setGeneration(Number(e.target.value))}
          className="w-full accent-cyan-600 dark:accent-cyan-400"
        />
        <span className="font-mono text-[11px] whitespace-nowrap text-slate-500 dark:text-slate-400">
          {generation.toLocaleString()} / 10,000
        </span>
      </div>
    </div>
  )
}

export function Showcase() {
  return (
    <div>
      <Navbar />

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-10">
        {/* -------------------------------------------------------- hero */}
        <section className="grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="mb-4 text-[11.5px] font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
              Computational biology &middot; evolutionary simulation
            </p>
            <h1 className="font-heading mb-5 text-4xl leading-[1.08] font-extrabold text-slate-900 sm:text-5xl dark:text-slate-50">
              Explore the evolution of <span className="gradient-text">telomeres.</span>
            </h1>
            <p className="mb-7 max-w-lg text-base leading-relaxed text-slate-700 sm:text-lg dark:text-slate-300">
              A computational laboratory for studying telomere dynamics, evolutionary trade-offs and biological
              longevity through simulation, optimisation and honest, reproducible data.
            </p>
            <div className="mb-9 flex flex-wrap gap-3.5">
              <a href="#simulation" className={btnPrimary}>
                Run Simulation &rarr;
              </a>
              <a href="#results" className={btnGhost}>
                See real results
              </a>
            </div>
            <div className="flex flex-wrap gap-6">
              {STATS.map((s) => {
                const Icon = s.icon
                return (
                  <div key={s.label} className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div>
                      <div className="font-heading text-lg font-extrabold text-slate-900 tabular-nums dark:text-slate-50">
                        {s.value}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{s.label}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          <HeroArt />
        </section>

        {/* ---------------------------------------------------- pillars */}
        <section id="features" className="scroll-mt-20 py-10">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PILLARS.map((p) => {
              const Icon = p.icon
              return (
                <Link key={p.title} to={p.path} className={`${card} flex flex-col`}>
                  <span className={`mb-4 flex h-10 w-10 items-center justify-center rounded-[11px] ${TINTS[p.tint]}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="font-heading mb-1.5 text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                    {p.title}
                  </div>
                  <p className="mb-3.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-slate-400">{p.desc}</p>
                  <span className="text-[12.5px] font-semibold text-cyan-700 dark:text-cyan-400">Open &rarr;</span>
                </Link>
              )
            })}
          </div>
        </section>

        {/* ------------------------------------------------ how it works */}
        <section className="py-12">
          <p className="mb-3 text-[11px] font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
            Under the hood
          </p>
          <h2 className="font-heading mb-2.5 text-[26px] font-bold text-slate-900 dark:text-slate-50">
            How the experimentation loop works
          </h2>
          <p className="prose-muted mb-9 max-w-2xl">
            Every run in the lab follows the same six-step loop &mdash; a biological hypothesis becomes a searchable
            parameter genome, gets scored by an explicit fitness function, and the winners seed the next generation.
          </p>
          <ol className="grid gap-6 sm:grid-cols-3 lg:grid-cols-6">
            {FLOW.map((step, i) => {
              const Icon = step.icon
              return (
                <li key={step.title} className="relative flex flex-col items-center gap-2.5 text-center">
                  {i < FLOW.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute top-[22px] left-[calc(50%+28px)] hidden h-px w-[calc(100%-16px)] bg-gradient-to-r from-cyan-400/60 to-violet-400/60 lg:block"
                    />
                  )}
                  <span className="card relative z-10 flex h-11 w-11 items-center justify-center !rounded-xl text-cyan-700 dark:text-cyan-400">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">{step.title}</div>
                  <div className="text-[11.5px] text-slate-500 dark:text-slate-400">{step.sub}</div>
                </li>
              )
            })}
          </ol>
        </section>

        {/* ================================================== live preview */}
        <section id="simulation" className="scroll-mt-20 py-10">
          <p className="mb-3 text-[11px] font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
            Try it, without logging in
          </p>
          <h2 className="font-heading mb-2.5 text-[26px] font-bold text-slate-900 dark:text-slate-50">
            Live simulation preview
          </h2>
          <p className="prose-muted mb-9 max-w-2xl">
            A sample population and parameter panel, styled like the real Simulate page &mdash; drag a slider, scrub
            the generation, or pick an individual below.
          </p>
          <LiveSimulationPreview />
        </section>

        {/* ======================================================= results */}
        <section id="results" className="scroll-mt-20 py-10">
          <p className="mb-3 text-[11px] font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
            Real findings, honestly reported
          </p>
          <h2 className="font-heading mb-2.5 text-[26px] font-bold text-slate-900 dark:text-slate-50">
            What the lab has actually found
          </h2>
          <p className="prose-muted mb-9 max-w-2xl">
            Every number below is from a documented, reproducible run in{' '}
            <code className="font-mono text-xs">docs/EXPERIMENT_PROTOCOL.md</code> &mdash; including the one that
            didn't go the way we expected.
          </p>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className={card}>
              <span className={`mb-3.5 inline-flex w-fit rounded px-2 py-0.5 font-mono text-[11px] font-bold ${TINTS.cyan}`}>
                Experiment G
              </span>
              <h3 className="font-heading mb-2 text-[15px] leading-snug font-bold text-slate-900 dark:text-slate-50">
                +0.045 fitness from syncing repair timing to a fasting-like stress rhythm
              </h3>
              <p className="mb-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                A 6-phase maintenance/repair schedule locked to an intermittent stress pattern beat a constant
                response by up to <strong className="text-slate-700 dark:text-slate-200">+0.5233 &rarr; +0.5688</strong>{' '}
                &mdash; timing itself matters, not just how much.
              </p>
              <div className="border-t border-slate-200 pt-3 font-mono text-[11px] text-slate-400 dark:border-white/10">
                docs/EXPERIMENT_PROTOCOL.md &sect;12
              </div>
            </div>
            <div className={card}>
              <span className={`mb-3.5 inline-flex w-fit rounded px-2 py-0.5 font-mono text-[11px] font-bold ${TINTS.cyan}`}>
                Experiment F
              </span>
              <h3 className="font-heading mb-2 text-[15px] leading-snug font-bold text-slate-900 dark:text-slate-50">
                A resilient sub-clone displaces a fragile one from 50% to 100% by cycle 75
              </h3>
              <p className="mb-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Two clones sharing one carrying-capacity: higher maintenance/repair keeps the resilient clone
                proliferative longer, compounding its share every division.
              </p>
              <div className="border-t border-slate-200 pt-3 font-mono text-[11px] text-slate-400 dark:border-white/10">
                docs/EXPERIMENT_PROTOCOL.md &sect;11
              </div>
            </div>
            <div className={card}>
              <span className={`mb-3.5 inline-flex w-fit rounded px-2 py-0.5 font-mono text-[11px] font-bold ${TINTS.cyan}`}>
                Experiment J
              </span>
              <h3 className="font-heading mb-2 text-[15px] leading-snug font-bold text-slate-900 dark:text-slate-50">
                The genetic algorithm got less reliable as the search grew &mdash; the surrogate didn't
              </h3>
              <p className="mb-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Across a 3&rarr;31-gene sweep, the GA's variance more than doubled past 10 genes, while a
                Gaussian-process learner stayed the most consistent &mdash; the opposite of what we expected.
              </p>
              <div className="border-t border-slate-200 pt-3 font-mono text-[11px] text-slate-400 dark:border-white/10">
                docs/EXPERIMENT_PROTOCOL.md &sect;15
              </div>
            </div>
          </div>
        </section>

        {/* ================================================ why it matters */}
        <section className="grid gap-10 py-12 lg:grid-cols-[1fr_1.15fr]">
          <div>
            <p className="mb-3 text-[11px] font-bold tracking-[0.2em] text-cyan-700 uppercase dark:text-cyan-400">
              Why it matters
            </p>
            <h2 className="font-heading mb-2.5 text-[30px] leading-tight font-bold text-slate-900 dark:text-slate-50">
              Small endings.
              <br />
              <span className="gradient-text">Big questions.</span>
            </h2>
            <p className="prose-muted mb-6 max-w-md">
              Telomeres sit at the intersection of aging, disease and evolution. By simulating their dynamics, we can
              explore fundamental questions about life-history strategies, longevity and the constraints of life
              &mdash; as a computational model, not a medical claim.
            </p>
            <Link to="/guide" className={btnGhost}>
              Read the scope &rarr;
            </Link>
          </div>
          <div className="flex flex-col gap-3.5">
            {[
              { icon: LightbulbIcon, tint: 'cyan' as const, title: 'Aging & Longevity', desc: 'Understand how telomere dynamics influence lifespan, in the model.' },
              { icon: ScaleIcon, tint: 'violet' as const, title: 'Evolutionary Trade-offs', desc: 'Explore the cost of maintenance vs. reproduction, quantitatively.' },
              { icon: TargetIcon, tint: 'pink' as const, title: 'Real-world Grounding', desc: 'Parameters checked against literature ranges, gaps documented, not hidden.' },
            ].map((m) => {
              const Icon = m.icon
              return (
                <div key={m.title} className={`${card} flex gap-3.5 hover:translate-y-0`}>
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${TINTS[m.tint]}`}>
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <div>
                    <div className="font-heading text-sm font-semibold text-slate-900 dark:text-slate-50">{m.title}</div>
                    <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{m.desc}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* ----------------------------------------------------------- cta */}
        <section className="py-6 pb-14">
          <div
            className="relative flex flex-col items-center gap-4 overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 px-8 py-14 text-center dark:border-white/10 dark:bg-slate-950"
            style={{
              backgroundImage:
                'radial-gradient(700px 300px at 15% 20%, rgba(8,145,178,0.08), transparent 60%), radial-gradient(600px 300px at 85% 80%, rgba(124,58,237,0.08), transparent 60%)',
            }}
          >
            <h2 className="font-heading relative text-2xl font-bold text-slate-900 sm:text-3xl dark:text-slate-50">
              Ready to run your first experiment?
            </h2>
            <p className="relative max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              Log in and the whole loop is yours &mdash; simulate a culture, evolve a protocol, and read the
              reproducibility ledger for every run.
            </p>
            <div className="relative mt-2 flex gap-3">
              <Link to="/register" className={btnPrimary}>
                Register &mdash; it's free
              </Link>
              <Link to="/login" className={btnGhost}>
                Log in
              </Link>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- footer */}
        <section className="space-y-3 pb-14">
          <Disclaimer />
          <p className="prose-muted max-w-3xl">
            Chip culture conditions (flow, oxygen, nutrients, exogenous stress, duration) are mapped to abstract
            simulation parameters on the Simulate page. The mapping is a documented modelling assumption; the model
            does not reproduce a physical chip. Fitness &ne; biological truth &mdash; the optimizer optimises the
            chosen computational objective under the chosen model assumptions.
          </p>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 py-8 dark:border-white/10">
          <div className="flex items-center gap-2.5">
            <LogoMark className="h-[22px] w-[22px]" />
            <span className="font-heading text-[13.5px] font-bold text-slate-900 dark:text-slate-50">
              Telomere Evolution Lab
            </span>
          </div>
          <div className="flex flex-wrap gap-5">
            <a href="#features" className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
              Features
            </a>
            <a href="#simulation" className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
              Simulation
            </a>
            <a href="#results" className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
              Results
            </a>
            <a
              href="/demo.html"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              Demo
            </a>
            <a
              href="https://basyid.dev"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              basyid.dev
            </a>
          </div>
        </footer>
      </div>
    </div>
  )
}
