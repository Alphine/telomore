import { motion, useReducedMotion } from 'framer-motion'
import { Command, Menu, ShieldCheck, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'

import { useAccess } from '../access/context'
import { useAuth } from '../auth/context'
import { FOCI_LAB_URL, NAV_FEATURES, PUBLIC_NAV_LINKS } from '../features'
import { ActiveJobsProvider } from '../jobs/ActiveJobsContext'
import { useActiveJobs } from '../jobs/useActiveJobs'
import { CommandPalette, useCommandPaletteShortcut } from './CommandPalette'
import { PlanBadge } from './PlanBadge'
import { ThemeToggle } from './ThemeToggle'
import { Button } from './ui/Button'

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
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
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
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-slate-700 dark:text-slate-300">
            Logged in as <code className="font-mono font-semibold">{user.username}</code>
          </span>
          <PlanBadge />
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/account"
            onClick={onNavigate}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <UserRound className="h-3.5 w-3.5" aria-hidden /> Account
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              logout()
              onNavigate?.()
              navigate('/')
            }}
          >
            Log out
          </Button>
        </div>
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
  const { isAdmin } = useAccess()
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
      <a href={FOCI_LAB_URL} target="_blank" rel="noreferrer" className={navClass({ isActive: false })} onClick={onNavigate}>
        <span aria-hidden>📷</span> Foci Lab <span aria-hidden className="ml-auto text-xs text-slate-400">↗</span>
        <span className="sr-only">(real microscopy, opens in a new tab)</span>
      </a>
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
      {isAdmin && (
        <>
          <div className="my-2 border-t border-slate-200 dark:border-slate-800" />
          <NavLink to="/admin" className={navClass} onClick={onNavigate}>
            <ShieldCheck className="h-4 w-4" aria-hidden /> Admin
          </NavLink>
        </>
      )}
    </nav>
  )
}

function PaletteButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open command palette"
      className={
        className ??
        'flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
      }
    >
      <span className="flex items-center gap-1.5">
        <Command className="h-3.5 w-3.5" aria-hidden /> Quick navigation
      </span>
      <kbd className="rounded border border-slate-200 px-1.5 py-0.5 font-sans text-[10px] dark:border-slate-700">Ctrl K</kbd>
    </button>
  )
}

/** Fades/slides the routed page in; a no-op under prefers-reduced-motion. */
function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation()
  const reduce = useReducedMotion()
  if (reduce) return <>{children}</>
  return (
    <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
    </motion.div>
  )
}

export function Layout({ children }: { children?: ReactNode } = {}) {
  const [open, setOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useCommandPaletteShortcut()
  const close = () => setOpen(false)

  return (
    <ActiveJobsProvider>
      <div className="min-h-screen lg:flex">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg dark:focus:bg-slate-900"
        >
          Skip to content
        </a>
        {/* Sidebar (lg+) */}
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col dark:border-slate-800 dark:bg-slate-900">
          <div className="px-5 py-5">
            <Link to="/" className="font-heading text-lg font-bold text-slate-900 dark:text-slate-50">
              🧬 Telomere Evolution Lab
            </Link>
          </div>
          <div className="px-3 pb-3">
            <PaletteButton onClick={() => setPaletteOpen(true)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
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
                {open ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />} Menu
              </button>
            </div>
          </div>
          {open && (
            <div id="mobile-nav" className="max-h-[75vh] space-y-4 overflow-y-auto border-t border-slate-200 px-4 py-4 dark:border-slate-800">
              <Nav onNavigate={close} />
              <AuthControls onNavigate={close} />
            </div>
          )}
        </header>

        <main id="main-content" className="min-w-0 flex-1" tabIndex={-1}>
          <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
            <PageTransition>{children ?? <Outlet />}</PageTransition>
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </ActiveJobsProvider>
  )
}
