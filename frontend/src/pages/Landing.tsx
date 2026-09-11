import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'

import { health } from '../api/endpoints'
import { Disclaimer } from '../components/Callout'
import { DnaHelixCanvas } from '../components/DnaHelixCanvas'
import { FEATURES } from '../features'

// Static for now (Phase 2): values mirror telomere_lab.__version__,
// MODEL_VERSION and OPTIMIZER_VERSION at the time of writing. A
// /api/version endpoint can replace these later.
const BUILD_INFO = `package    0.1.0
model      0.1.0
optimizer  0.1.0`

// Hero stat pills (2026-09-11 landing polish pass): every number here was
// actually counted, not guessed -- like BUILD_INFO above, this is a
// documented, dated, static snapshot, not a live measurement. Re-run these
// counts and update the literals below whenever a future session revisits
// this section, rather than letting them go stale silently (see
// `frontend/README.md`'s "Landing hero" section for the exact commands):
//   - backend tests: `python -m pytest -q` (junitxml `tests=` count, NOT a
//     manual per-file sum from --collect-only -q, which undercounted
//     parametrized tests when this was first written) = 251 (2026-09-11)
//   - frontend tests: `cd frontend && npx vitest run` = 139 (2026-09-11)
//   - lab tools: `FEATURES.length` (features.ts) = 7
//   - documented experiments: `## N. Experiment` headers in
//     docs/EXPERIMENT_PROTOCOL.md = 6 (A-F)
const STATS: { icon: string; value: string; label: string }[] = [
  { icon: '✅', value: '390', label: 'automated tests (251 backend + 139 frontend)' },
  { icon: '🧪', value: `${FEATURES.length}`, label: 'lab tools' },
  { icon: '📒', value: '6', label: 'documented experiments' },
  { icon: '💻', value: 'CPU-only', label: 'no GPU required' },
]

const STEPS: { title: string; sub: string }[] = [
  { title: 'Simulate', sub: 'run the stressed baseline culture' },
  { title: 'Evolve', sub: 'search parameters for the objective' },
  { title: 'Compare', sub: 'overlay baseline vs. evolved' },
  { title: 'Experiments', sub: 'inspect the reproducibility ledger' },
]

const LOOP = `biological hypothesis / objective
        ↓
  parameter genome  (stress, maintenance, repair, ...)
        ↓
  telomere simulation  (population of cells × telomeres, per cycle)
        ↓
  biological outcomes  (length, senescence, survival)
        ↓
  fitness score  (explicit weighted objective)
        ↓
  mutation / selection → next generation  ↺`

type ApiStatus = { state: 'loading' } | { state: 'ok'; status: string } | { state: 'error'; message: string }

function BuildSection() {
  const [api, setApi] = useState<ApiStatus>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    health()
      .then((h) => {
        if (!cancelled) setApi({ state: 'ok', status: h.status })
      })
      .catch((err: unknown) => {
        if (!cancelled) setApi({ state: 'error', message: err instanceof Error ? err.message : 'unreachable' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <details className="card group px-5 py-4">
      <summary className="cursor-pointer select-none text-sm font-semibold text-slate-800 marker:text-slate-400 dark:text-slate-100">
        Build, model backends &amp; measured performance
      </summary>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-semibold">Build</h4>
          <pre className="mono-block">{BUILD_INFO}</pre>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">API status</h4>
          <div className="mono-block" data-testid="api-status">
            {api.state === 'ok' ? (
              <>
                GET /api/health →{' '}
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">{api.status}</span>
              </>
            ) : api.state === 'error' ? (
              <>
                GET /api/health → <span className="font-semibold text-rose-700 dark:text-rose-400">error</span>
                <div className="mt-1 text-xs opacity-80">{api.message}</div>
              </>
            ) : (
              'GET /api/health … '
            )}
          </div>
          <p className="prose-muted mt-3">
            Model backends and measured performance will be surfaced here once the corresponding API
            endpoints exist (Phase 3+).
          </p>
        </div>
      </div>
    </details>
  )
}

export function Landing() {
  // The backend builds emailed / dev-mode links as `/?token=` and
  // `/?reset_token=` on the root path (backend/routers/auth.py). Redirect
  // those onto the routes that handle them.
  const [params] = useSearchParams()
  const verifyToken = params.get('token')
  const resetToken = params.get('reset_token')
  if (verifyToken) return <Navigate to={`/verify?token=${encodeURIComponent(verifyToken)}`} replace />
  if (resetToken) return <Navigate to={`/reset-password?token=${encodeURIComponent(resetToken)}`} replace />

  return (
    <div className="space-y-12">
      {/* ---------------------------------------------------------- hero */}
      <section className="hero-glow relative space-y-5 overflow-hidden rounded-2xl px-1 py-2 sm:px-2">
        {/* Decorative only -- aria-hidden inside the component, no data dependency.
            Absolutely positioned behind the text on narrow screens (low opacity so
            the hero copy stays the clear focal point), a contained side panel on
            wider screens. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-10 sm:static sm:float-right sm:ms-4 sm:mb-2 sm:h-56 sm:w-56 sm:opacity-90"
        >
          <DnaHelixCanvas />
        </div>

        <p className="relative text-xs font-semibold tracking-[0.2em] text-sky-700 uppercase dark:text-sky-400">
          Simulate · Evolve · Compare · Learn
        </p>
        <h1 className="relative text-4xl font-bold sm:text-5xl">
          <span className="block">🧬 Telomere</span>
          <span className="gradient-text block">Evolution Lab</span>
        </h1>
        <p className="relative text-xs font-semibold tracking-[0.15em] text-slate-500 uppercase dark:text-slate-400">
          AI-for-science telomere simulation lab
        </p>
        <h2 className="relative text-xl font-semibold text-slate-700 sm:text-2xl dark:text-slate-300">
          Simulate. Evolve. Compare. Learn.
        </h2>
        <p className="relative max-w-3xl text-base leading-relaxed text-slate-700 dark:text-slate-300">
          An interactive AI-for-Science laboratory where an <strong>evolutionary optimizer</strong> searches a{' '}
          <strong>telomere-dynamics model</strong> for virtual experiment conditions that optimise an explicit,
          user-defined objective.
        </p>

        {/* ------------------------------------------------- stat pills */}
        <div className="relative flex flex-wrap gap-3 pt-1">
          {STATS.map((s) => (
            <div key={s.label} className="glass-pill">
              <span aria-hidden className="text-lg leading-none">
                {s.icon}
              </span>
              <div>
                <div className="text-sm font-bold text-slate-900 dark:text-slate-50">{s.value}</div>
                <div className="text-xs text-slate-600 dark:text-slate-400">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="relative">
          <Disclaimer />
        </div>
      </section>

      {/* -------------------------------------------------- feature cards */}
      <section>
        <h3 className="mb-4 text-lg font-semibold">Explore the lab</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Link
              key={f.path}
              to={f.path}
              data-testid="feature-card"
              className="glass-panel glass-panel-hover flex flex-col p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
            >
              <div aria-hidden className="text-3xl leading-none">
                {f.icon}
              </div>
              <div className="mt-3 font-semibold text-slate-900 dark:text-slate-50">{f.title}</div>
              <p className="prose-muted mt-1 flex-1">{f.description}</p>
              <span className="link mt-4 text-sm">Open {f.title} →</span>
            </Link>
          ))}
        </div>
        <p className="prose-muted mt-4" data-testid="llm-callout">
          Every recorded run can also be narrated by an LLM on your own Anthropic key (Experiments → inspect a run →{' '}
          <em>AI interpretation</em>, or right under any finished optimizer result): a read-only, model-result narration
          under the same scope policy — it never runs or changes a simulation.
        </p>
      </section>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* -------------------------------------------------- how it works */}
      <section>
        <h3 className="mb-4 text-lg font-semibold">The virtual experimentation loop</h3>
        <pre className="mono-block">{LOOP}</pre>
      </section>

      {/* ---------------------------------------------------- step flow */}
      <section>
        <h3 className="mb-6 text-lg font-semibold">Suggested demo flow</h3>
        <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="relative flex items-start gap-3 sm:flex-col sm:items-center sm:text-center">
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-4 left-[calc(2rem+1px)] hidden h-px w-[calc(100%-2rem)] bg-gradient-to-r from-sky-400/70 to-violet-400/70 sm:block"
                />
              )}
              <span
                aria-hidden
                className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-violet-500 text-sm font-bold text-white shadow-[0_0_12px_-2px_rgba(96,165,250,0.7)]"
              >
                {i + 1}
              </span>
              <div>
                <div className="font-semibold text-slate-900 dark:text-slate-50">{step.title}</div>
                <div className="prose-muted">{step.sub}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------------------------------------------------- build info */}
      <BuildSection />

      <hr className="border-slate-200 dark:border-slate-800" />

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Organ-on-a-chip framing</h3>
        <p className="max-w-3xl leading-relaxed text-slate-700 dark:text-slate-300">
          Chip culture conditions (flow, oxygen, nutrients, exogenous stress, duration) are mapped to abstract
          simulation parameters on the Simulate page. The mapping is a documented{' '}
          <strong>modelling assumption</strong>; the model does not reproduce a physical chip. See{' '}
          <code className="font-mono text-sm">docs/MODEL.md</code> and{' '}
          <code className="font-mono text-sm">docs/SCIENTIFIC_SCOPE.md</code> -- both readable in full, alongside the
          program overview, on the <Link to="/guide" className="link">in-app Docs page</Link>.
        </p>
        <p className="prose-muted">
          Fitness ≠ biological truth. The optimizer optimises the chosen computational objective under the chosen
          model assumptions.
        </p>
      </section>
    </div>
  )
}
