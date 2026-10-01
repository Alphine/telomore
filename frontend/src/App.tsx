import { Suspense, lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import { Route, Routes } from 'react-router-dom'

import { RequireAdmin } from './auth/RequireAdmin'
import { RequireAuth } from './auth/RequireAuth'
import { Layout } from './components/Layout'
import { Skeleton } from './components/ui/Skeleton'
import { FeatureGate } from './demo/FeatureGate'
import { FEATURES } from './features'
import { Account } from './pages/Account'
import { Docs } from './pages/Docs'
import { ForgotPassword } from './pages/ForgotPassword'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
import { Placeholder } from './pages/Placeholder'
import { Register } from './pages/Register'
import { ResetPassword } from './pages/ResetPassword'
import { Verify } from './pages/Verify'

// Feature pages are route-level chunks: the main bundle stays small, and the
// heavy chart/3D code only loads once a page that needs it is opened.
const lazyNamed = <T extends ComponentType>(load: () => Promise<Record<string, unknown>>, name: string) =>
  lazy(async () => ({ default: (await load())[name] as T }))

const MIGRATED: Record<string, LazyExoticComponent<ComponentType>> = {
  '/simulate': lazyNamed(() => import('./pages/Simulate'), 'Simulate'),
  '/evolve': lazyNamed(() => import('./pages/Evolve'), 'Evolve'),
  '/pareto': lazyNamed(() => import('./pages/Pareto'), 'Pareto'),
  '/sensitivity': lazyNamed(() => import('./pages/Sensitivity'), 'Sensitivity'),
  '/gxe': lazyNamed(() => import('./pages/GxE'), 'GxE'),
  '/active-learning': lazyNamed(() => import('./pages/ActiveLearning'), 'ActiveLearning'),
  '/compare': lazyNamed(() => import('./pages/Compare'), 'Compare'),
  '/experiments': lazyNamed(() => import('./pages/Experiments'), 'Experiments'),
  '/genome': lazyNamed(() => import('./pages/GenomeExplorer'), 'GenomeExplorer'),
}

// The admin area is its own lazy chunk: ordinary visitors never download it.
const AdminApp = lazy(() => import('./admin/AdminApp'))

function RouteFallback() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading page">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-24" />
      <Skeleton className="h-64" />
    </div>
  )
}

/** Route table; the Router itself is provided by main.tsx (or a MemoryRouter in tests). */
export default function App() {
  return (
    <Routes>
      {/* Not wrapped in <Layout/> -- Home picks between the sidebar-wrapped
          Landing dashboard (authenticated) and the full-bleed, sidebar-free
          pre-login Showcase page (anonymous) itself. */}
      <Route path="/" element={<Home />} />
      <Route element={<Layout />}>
        {/* `/guide`, not `/docs` -- see features.ts's PUBLIC_NAV_LINKS comment: */}
        {/* FastAPI's own Swagger UI already owns `/docs` in production. */}
        <Route path="/guide" element={<Docs />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify" element={<Verify />} />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <Account />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/*"
          element={
            <RequireAdmin>
              <Suspense fallback={<RouteFallback />}>
                <AdminApp />
              </Suspense>
            </RequireAdmin>
          }
        />
        {/* Feature pages need no login: anonymous and free visitors get the
            cached demo, pro users and admins the live page (FeatureGate). */}
        {FEATURES.map((f) => {
          const Page = MIGRATED[f.path]
          return (
            <Route
              key={f.path}
              path={f.path}
              element={
                <FeatureGate feature={f.path.slice(1)}>
                  <Suspense fallback={<RouteFallback />}>{Page ? <Page /> : <Placeholder feature={f} />}</Suspense>
                </FeatureGate>
              }
            />
          )
        })}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
