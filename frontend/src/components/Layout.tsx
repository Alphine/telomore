import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/context'
import { NAV_FEATURES, PUBLIC_NAV_LINKS } from '../features'
import { ActiveJobsProvider } from '../jobs/ActiveJobsContext'
import { useActiveJobs } from '../jobs/useActiveJobs'
import { ThemeToggle } from './ThemeToggle'

// Maps a background-job `kind` (backend/routers/*.py's `create_job(kind=...)`)
// to the nav path that started it, so a page's own "in progress" state is
// visible from anywhere in the app (docs/API.md "Long-running jobs").
// `benchmark` has no dedicated nav page, so it's intentionally omitted.
const JOB_KIND_TO_PATH: Record<string, string> = {
  evolve: '/evolve',
  pareto: '/pareto',
  sensitivity: '/sensitivity',
  gxe: '/gxe',
  active_learning: '/active-learning',
}

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
    isActive
      ? 'bg-teal-50 text-teal-800 dark:bg-teal-500/10 dark:text-teal-300'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
  ].join(' ')
}

function AuthControls({ onNavigate }: { onNavigate?: () => void }) {
  const { status, user, logout } = useAuth()
  const navigate = useNavigate()

  if (status === 'loading') {
    return <span className="prose-muted">Checking session…</span>
  }
  if (status === 'authenticated' && user) {
    return (
      <div className="flex items-center gap-3">
        <span className="truncate text-sm text-slate-700 dark:text-slate-300">
          Logged in as <code className="font-mono font-semibold">{user.username}</code>
        </span>
        <button
          type="button"
          className="btn-ghost !px-3 !py-1.5"
          onClick={() => {
            logout()
            onNavigate?.()
            navigate('/')
          }}
        >
          Log out
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Link to="/login" className="btn-ghost !px-3 !py-1.5" onClick={onNavigate}>
        Log in
      </Link>
      <Link to="/register" className="btn-primary !px-3 !py-1.5" onClick={onNavigate}>
        Register
      </Link>
    </div>
  )
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const activeJobs = useActiveJobs()
  const hasActiveJob = (path: string) => activeJobs.some((j) => JOB_KIND_TO_PATH[j.kind] === path)

  return (
    <nav className="flex flex-col gap-1" aria-label="Lab pages">
      <NavLink to="/" end className={navClass} onClick={onNavigate}>
        <span aria-hidden>🏠</span> Home
      </NavLink>
      {PUBLIC_NAV_LINKS.map((f) => (
        <NavLink key={f.path} to={f.path} className={navClass} onClick={onNavigate}>
          <span aria-hidden>{f.icon}</span> {f.title}
        </NavLink>
      ))}
      <div className="my-2 border-t border-slate-200 dark:border-slate-800" />
      {NAV_FEATURES.map((f) => (
        <NavLink key={f.path} to={f.path} className={navClass} onClick={onNavigate}>
          <span aria-hidden>{f.icon}</span> {f.title}
          {hasActiveJob(f.path) && (
            <span
              className="ml-auto animate-pulse text-xs"
              aria-label={`${f.title} has a job in progress`}
              title="Job in progress"
              data-testid={`nav-job-badge-${f.path}`}
            >
              ⏳
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout() {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <ActiveJobsProvider>
      <div className="min-h-screen lg:flex">
        {/* Sidebar (lg+) */}
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col dark:border-slate-800 dark:bg-slate-900">
          <div className="px-5 py-5">
            <Link to="/" className="font-heading text-lg font-bold text-slate-900 dark:text-slate-50">
              🧬 Telomere Evolution Lab
            </Link>
          </div>
          <div className="flex-1 px-3">
            <Nav />
          </div>
          <div className="space-y-3 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
            <ThemeToggle />
            <AuthControls />
          </div>
        </aside>

        {/* Top bar (below lg) */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex items-center justify-between px-4 py-3">
            <Link to="/" className="font-heading text-base font-bold" onClick={close}>
              🧬 Telomere Evolution Lab
            </Link>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                type="button"
                className="btn-ghost !px-3 !py-1.5"
                aria-expanded={open}
                aria-controls="mobile-nav"
                onClick={() => setOpen((v) => !v)}
              >
                Menu
              </button>
            </div>
          </div>
          {open && (
            <div id="mobile-nav" className="space-y-4 border-t border-slate-200 px-4 py-4 dark:border-slate-800">
              <Nav onNavigate={close} />
              <AuthControls onNavigate={close} />
            </div>
          )}
        </header>

        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
            <Outlet />
          </div>
        </main>
      </div>
    </ActiveJobsProvider>
  )
}
