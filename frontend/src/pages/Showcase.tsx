import type { SVGProps } from 'react'
import { Link } from 'react-router-dom'

import { Disclaimer } from '../components/Callout'
import {
  BarsIcon,
  CheckIcon,
  ChipIcon,
  FEATURE_ICONS,
  LedgerIcon,
  LightbulbIcon,
  LogoMark,
  RefreshIcon,
  ScatterIcon,
  TargetIcon,
} from '../components/icons'
import { ThemeToggle } from '../components/ThemeToggle'
import { FEATURES } from '../features'

// Pre-login "show off" page (2026-09-16): a standalone, full-bleed marketing
// page shown to anonymous visitors at "/" instead of the sidebar-wrapped
// Landing dashboard (pages/Home.tsx picks between the two by auth status).
// Every number here mirrors Landing.tsx's own "counted, not guessed"
// discipline (see that file's STATS comment) and every "Results" claim below
// is a real, reproducible finding cited to its docs/EXPERIMENT_PROTOCOL.md
// section -- not a fabricated case study.

const STATS: { icon: (p: SVGProps<SVGSVGElement>) => JSX.Element; value: string; label: string }[] = [
  { icon: CheckIcon, value: '489', label: 'automated tests (313 backend + 176 frontend)' },
  { icon: ScatterIcon, value: `${FEATURES.length}`, label: 'lab tools' },
  { icon: LedgerIcon, value: '10', label: 'documented experiments' },
  { icon: ChipIcon, value: 'CPU-only', label: 'no GPU required' },
]

const FLOW: { icon: (p: SVGProps<SVGSVGElement>) => JSX.Element; title: string; sub: string }[] = [
  { icon: LightbulbIcon, title: 'Hypothesis', sub: 'a biological question & objective' },
  { icon: FEATURE_ICONS['/evolve'], title: 'Parameter genome', sub: 'stress, maintenance, repair, ...' },
  { icon: FEATURE_ICONS['/simulate'], title: 'Simulation', sub: 'population × telomeres, per cycle' },
  { icon: BarsIcon, title: 'Biological outcomes', sub: 'length, senescence, survival' },
  { icon: TargetIcon, title: 'Fitness score', sub: 'explicit weighted objective' },
  { icon: RefreshIcon, title: 'Selection', sub: 'mutate & seed next generation' },
]

function Navbar() {
  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark className="h-6 w-6 shrink-0" />
          <span className="font-heading hidden truncate text-[15px] font-bold text-slate-900 sm:inline dark:text-slate-50">
            Telomere Evolution Lab
          </span>
        </div>
        <nav className="hidden items-center gap-7 md:flex" aria-label="Page sections">
          <a href="#features" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            Features
          </a>
          <a href="#how-it-works" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            How it works
          </a>
          <a href="#results" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            Results
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link to="/login" className="btn-ghost !px-3 !py-1.5">
            Log in
          </Link>
          <Link to="/register" className="btn-primary !px-3 !py-1.5">
            Register
          </Link>
        </div>
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
        <section className="hero-glow relative space-y-6 overflow-hidden py-16 sm:py-20">
          <p className="relative text-xs font-semibold tracking-[0.2em] text-sky-700 uppercase dark:text-sky-400">
            AI-for-science &middot; telomere simulation lab
          </p>
          <h1 className="relative max-w-3xl text-4xl font-bold sm:text-5xl">
            Evolve smarter biology,{' '}
            <span className="gradient-text block">one simulated cycle at a time.</span>
          </h1>
          <p className="relative max-w-2xl text-lg leading-relaxed text-slate-700 dark:text-slate-300">
            An interactive AI-for-Science laboratory where an <strong>evolutionary optimizer</strong> searches a{' '}
            <strong>telomere-dynamics model</strong> for the intervention conditions that best satisfy an explicit,
            user-defined objective &mdash; then lets you replay, compare and interrogate exactly why it won.
          </p>
          <div className="relative flex flex-wrap gap-3">
            <Link to="/register" className="btn-primary !px-6 !py-3 !text-[15px]">
              Register &mdash; it's free
            </Link>
            <a href="#how-it-works" className="btn-ghost !px-6 !py-3 !text-[15px]">
              See how it works
            </a>
          </div>
          <div className="relative flex flex-wrap gap-3 pt-2">
            {STATS.map((s) => {
              const Icon = s.icon
              return (
                <div key={s.label} className="glass-pill">
                  <span
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300"
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-50">{s.value}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-400">{s.label}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* ---------------------------------------------------- how it works */}
        <section id="how-it-works" className="scroll-mt-20 py-16">
          <p className="text-xs font-semibold tracking-[0.2em] text-sky-700 uppercase dark:text-sky-400">
            Under the hood
          </p>
          <h2 className="mt-3 font-heading text-2xl font-bold text-slate-900 dark:text-slate-50">
            How the experimentation loop works
          </h2>
          <p className="prose-muted mt-2 mb-10 max-w-2xl">
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
                      className="absolute top-[22px] left-[calc(50%+28px)] hidden h-px w-[calc(100%-16px)] bg-gradient-to-r from-sky-400/70 to-violet-400/70 lg:block"
                    />
                  )}
                  <span className="card relative z-10 flex h-11 w-11 items-center justify-center !rounded-xl text-teal-700 dark:text-teal-300">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">{step.title}</div>
                  <div className="text-[11.5px] text-slate-600 dark:text-slate-400">{step.sub}</div>
                </li>
              )
            })}
          </ol>
          <div className="mt-8 flex justify-center">
            <span className="mono-block inline-flex items-center gap-2 !py-2 text-xs">
              <RefreshIcon className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
              repeats every generation until the objective converges
            </span>
          </div>
        </section>

        {/* -------------------------------------------------------- features */}
        <section id="features" className="scroll-mt-20 py-16">
          <p className="text-xs font-semibold tracking-[0.2em] text-sky-700 uppercase dark:text-sky-400">
            Eight lab tools
          </p>
          <h2 className="mt-3 font-heading text-2xl font-bold text-slate-900 dark:text-slate-50">Explore the lab</h2>
          <p className="prose-muted mt-2 mb-10 max-w-2xl">
            Every tool shares the same simulator core and the same reproducibility ledger &mdash; nothing here runs a
            "different model" behind the scenes.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => {
              const Icon = FEATURE_ICONS[f.path]
              return (
                <div key={f.path} className="glass-panel glass-panel-hover flex flex-col p-5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-50">{f.title}</div>
                  <p className="prose-muted mt-1 text-xs">{f.description}</p>
                </div>
              )
            })}
          </div>
        </section>

        {/* --------------------------------------------------------- results */}
        <section id="results" className="scroll-mt-20 py-16">
          <p className="text-xs font-semibold tracking-[0.2em] text-sky-700 uppercase dark:text-sky-400">
            Real findings, honestly reported
          </p>
          <h2 className="mt-3 font-heading text-2xl font-bold text-slate-900 dark:text-slate-50">
            What the lab has actually found
          </h2>
          <p className="prose-muted mt-2 mb-10 max-w-2xl">
            Every number below is from a documented, reproducible run in{' '}
            <code className="font-mono text-xs">docs/EXPERIMENT_PROTOCOL.md</code> &mdash; including the one that
            didn't go the way we expected.
          </p>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="card flex flex-col p-5">
              <span className="mb-3 inline-flex w-fit rounded bg-teal-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-teal-800 dark:bg-teal-500/10 dark:text-teal-300">
                Experiment G
              </span>
              <h3 className="font-heading mb-2 text-base font-bold text-slate-900 dark:text-slate-50">
                +0.045 fitness from syncing repair timing to a fasting-like stress rhythm
              </h3>
              <p className="prose-muted mb-4 flex-1">
                Evolving a 6-phase maintenance/repair schedule locked to an intermittent stress pattern beat a
                constant response by up to{' '}
                <strong className="text-slate-800 dark:text-slate-200">+0.5233 &rarr; +0.5688</strong> (the "extreme"
                pattern) &mdash; a real, mechanistic case where <em>when</em> you respond matters, not just how much.
              </p>
              <svg viewBox="0 0 220 90" className="mb-3 h-[90px] w-full">
                <line x1="20" y1="76" x2="200" y2="76" className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                <rect x="45" y="40" width="34" height="36" rx="3" className="fill-slate-300 dark:fill-slate-600" />
                <rect x="140" y="18" width="34" height="58" rx="3" fill="#0d9488" />
                <text x="62" y="88" fontSize="9" textAnchor="middle" fontFamily="ui-monospace,monospace" className="fill-slate-400">
                  constant
                </text>
                <text x="157" y="88" fontSize="9" textAnchor="middle" fontFamily="ui-monospace,monospace" className="fill-slate-400">
                  scheduled
                </text>
              </svg>
              <div className="border-t border-slate-200 pt-3 font-mono text-[11px] text-slate-400 dark:border-slate-800">
                docs/EXPERIMENT_PROTOCOL.md &sect;12
              </div>
            </div>

            <div className="card flex flex-col p-5">
              <span className="mb-3 inline-flex w-fit rounded bg-teal-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-teal-800 dark:bg-teal-500/10 dark:text-teal-300">
                Experiment F
              </span>
              <h3 className="font-heading mb-2 text-base font-bold text-slate-900 dark:text-slate-50">
                A resilient sub-clone displaces a fragile one from 50% to 100% by cycle 75
              </h3>
              <p className="prose-muted mb-4 flex-1">
                Two genetically distinct clones sharing one carrying-capacity: higher maintenance/repair keeps the
                resilient clone proliferative longer, compounding its share every division &mdash; a clear, non-null
                competitive-exclusion result.
              </p>
              <svg viewBox="0 0 220 90" className="mb-3 h-[90px] w-full">
                <line x1="20" y1="76" x2="200" y2="76" className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                <line x1="20" y1="10" x2="20" y2="76" className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                <polyline points="20,43 70,15 130,10 200,10" fill="none" stroke="#0d9488" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="20,43 70,70 130,75 200,75" fill="none" stroke="#7c3aed" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                <text x="20" y="86" fontSize="9" fontFamily="ui-monospace,monospace" className="fill-slate-400">0</text>
                <text x="180" y="86" fontSize="9" fontFamily="ui-monospace,monospace" className="fill-slate-400">150 cyc</text>
              </svg>
              <div className="border-t border-slate-200 pt-3 font-mono text-[11px] text-slate-400 dark:border-slate-800">
                docs/EXPERIMENT_PROTOCOL.md &sect;11
              </div>
            </div>

            <div className="card flex flex-col p-5">
              <span className="mb-3 inline-flex w-fit rounded bg-teal-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-teal-800 dark:bg-teal-500/10 dark:text-teal-300">
                Experiment J
              </span>
              <h3 className="font-heading mb-2 text-base font-bold text-slate-900 dark:text-slate-50">
                The genetic algorithm got less reliable as the search grew &mdash; the surrogate model didn't
              </h3>
              <p className="prose-muted mb-4 flex-1">
                Across a 3&rarr;31-gene sweep under a fixed budget, the GA's run-to-run variance more than doubled
                past 10 genes, while a Gaussian-process active learner stayed the most consistent method at every
                size &mdash; the opposite of what we expected going in.
              </p>
              <svg viewBox="0 0 220 90" className="mb-3 h-[90px] w-full">
                <line x1="20" y1="76" x2="200" y2="76" className="stroke-slate-200 dark:stroke-slate-700" strokeWidth={1} />
                {[30, 42, 55, 20, 63].map((y, i) => (
                  <circle key={`ga-${i}`} cx="60" cy={y} r="2.2" fill="#7c3aed" />
                ))}
                {[36, 40, 38, 34, 39].map((y, i) => (
                  <circle key={`al-${i}`} cx="150" cy={y} r="2.2" fill="#0d9488" />
                ))}
                <text x="60" y="86" fontSize="9" textAnchor="middle" fontFamily="ui-monospace,monospace" className="fill-slate-400">GA</text>
                <text x="150" y="86" fontSize="9" textAnchor="middle" fontFamily="ui-monospace,monospace" className="fill-slate-400">surrogate</text>
              </svg>
              <div className="border-t border-slate-200 pt-3 font-mono text-[11px] text-slate-400 dark:border-slate-800">
                docs/EXPERIMENT_PROTOCOL.md &sect;15
              </div>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- cta */}
        <section className="py-6 pb-16">
          <div className="hero-glow relative flex flex-col items-center gap-4 overflow-hidden rounded-2xl bg-slate-900 px-8 py-14 text-center dark:bg-slate-950">
            <h2 className="font-heading relative text-2xl font-bold text-slate-50 sm:text-3xl">
              Ready to run your first experiment?
            </h2>
            <p className="relative max-w-md text-sm leading-relaxed text-slate-300">
              Log in and the whole loop is yours &mdash; simulate a culture, evolve a protocol, and read the
              reproducibility ledger for every run.
            </p>
            <div className="relative mt-2 flex gap-3">
              <Link to="/register" className="btn-primary !px-6 !py-3 !text-[15px]">
                Register &mdash; it's free
              </Link>
              <Link to="/login" className="btn-ghost !border-white/30 !px-6 !py-3 !text-[15px] !text-slate-50 hover:!bg-white/10">
                Log in
              </Link>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- footer */}
        <section className="space-y-3 pb-16">
          <Disclaimer />
          <p className="prose-muted max-w-3xl">
            Chip culture conditions (flow, oxygen, nutrients, exogenous stress, duration) are mapped to abstract
            simulation parameters on the Simulate page. The mapping is a documented modelling assumption; the model
            does not reproduce a physical chip. Fitness &ne; biological truth &mdash; the optimizer optimises the
            chosen computational objective under the chosen model assumptions.
          </p>
        </section>
      </div>
    </div>
  )
}
