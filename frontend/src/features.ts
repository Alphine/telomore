// Mirrors FEATURES in app/streamlit_app.py (icon, title, description) --
// wording copied verbatim; `path` is the React route.
export interface Feature {
  icon: string
  title: string
  description: string
  path: string
}

export const FEATURES: Feature[] = [
  {
    icon: '🔬',
    title: 'Simulate',
    description:
      'Run a single virtual experiment and inspect telomere length, senescence and survival trajectories.',
    path: '/simulate',
  },
  {
    icon: '🧬',
    title: 'Evolve',
    description:
      'Define an objective and let a genetic algorithm search for parameter conditions that optimise it.',
    path: '/evolve',
  },
  {
    icon: '🎯',
    title: 'Pareto',
    description:
      'Run NSGA-II to see the full trade-off surface between competing objectives, not just one weighted winner.',
    path: '/pareto',
  },
  {
    icon: '📐',
    title: 'Sensitivity',
    description:
      'See which parameters move fitness the most with one-at-a-time (OAT) sensitivity analysis.',
    path: '/sensitivity',
  },
  {
    icon: '⚖️',
    title: 'Compare',
    description:
      'Overlay baseline vs. evolved vs. hand-picked scenarios side by side and read the deltas.',
    path: '/compare',
  },
  {
    icon: '📒',
    title: 'Experiments',
    description:
      'Browse the reproducibility ledger and download complete run bundles for any past experiment.',
    path: '/experiments',
  },
  {
    icon: '🧭',
    title: 'Active Learning',
    description:
      'A Gaussian-process surrogate + Expected Improvement chooses which configuration to test next, reaching good fitness with fewer real simulator runs.',
    path: '/active-learning',
  },
]

// Sidebar order follows st.navigation() in app/streamlit_app.py.
export const NAV_ORDER = [
  '/simulate',
  '/evolve',
  '/pareto',
  '/sensitivity',
  '/active-learning',
  '/compare',
  '/experiments',
]

export const NAV_FEATURES: Feature[] = NAV_ORDER.map(
  (p) => FEATURES.find((f) => f.path === p) as Feature,
)

// Public, unauthenticated nav links -- same tier as Landing (`/`), reachable
// without login. Deliberately NOT part of FEATURES/NAV_FEATURES: those drive
// the Landing feature-card grid and the "N lab tools" stat pill, and Docs is
// explanatory material, not a lab tool.
//
// Route is `/guide`, not `/docs`: this app serves the FastAPI backend and the
// React SPA from one origin (`backend/main.py`), and FastAPI's own
// interactive API docs already own `/docs` (Swagger UI, registered before the
// SPA catch-all) -- a React route at `/docs` would be permanently
// unreachable in production. Confirmed by hitting `/docs` on a real built +
// served app during this feature's e2e check.
export interface NavLink {
  icon: string
  title: string
  path: string
}

export const PUBLIC_NAV_LINKS: NavLink[] = [
  { icon: '📖', title: 'Docs', path: '/guide' },
]

// Copied verbatim from app/ui/components.py::DISCLAIMER (markdown emphasis
// rendered as JSX in <Disclaimer />).
export const DISCLAIMER_PARTS = {
  lead: 'Scope.',
  body1: ' This is a computational research prototype. Every number on this page is a ',
  em: 'model output',
  body2:
    ' under the stated assumptions. It does not provide medical advice, clinical predictions, or validated therapeutic recommendations. Parameters named after biological processes are simulation parameters, not interventions.',
}
