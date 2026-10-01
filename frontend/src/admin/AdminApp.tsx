import { Link, NavLink, Route, Routes } from 'react-router-dom'

import { cn } from '../lib/cn'
import AuditPage from './AuditPage'
import OverviewPage from './OverviewPage'
import RequestsPage from './RequestsPage'
import UsagePage from './UsagePage'
import UsersPage from './UsersPage'

const TABS = [
  { to: '', label: 'Overview', end: true },
  { to: 'users', label: 'Users' },
  { to: 'requests', label: 'Requests' },
  { to: 'usage', label: 'Usage' },
  { to: 'audit', label: 'Audit log' },
]

function NotFound() {
  return (
    <div className="py-12 text-center">
      <p className="font-medium">That admin page does not exist.</p>
      <Link to="/admin" className="link mt-2 inline-block">
        Back to Overview
      </Link>
    </div>
  )
}

/** Mounted at `/admin/*` (inside Layout, behind RequireAdmin). */
export default function AdminApp() {
  return (
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-3xl font-bold">Admin</h1>
          <p className="prose-muted mt-1">Users, Pro access requests, API usage and the audit log. Times are UTC.</p>
        </div>
        <nav aria-label="Admin sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="m-0 flex w-max min-w-full list-none gap-1 border-b border-slate-200 p-0 dark:border-slate-800">
            {TABS.map((t) => (
              <li key={t.label}>
                <NavLink
                  to={t.to === '' ? '.' : t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cn(
                      '-mb-px block whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
                      isActive
                        ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                        : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <Routes>
          <Route index element={<OverviewPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
  )
}
