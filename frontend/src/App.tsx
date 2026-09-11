import { Route, Routes } from 'react-router-dom'

import { RequireAuth } from './auth/RequireAuth'
import { Layout } from './components/Layout'
import { FEATURES } from './features'
import { Docs } from './pages/Docs'
import { ForgotPassword } from './pages/ForgotPassword'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
import { ActiveLearning } from './pages/ActiveLearning'
import { Compare } from './pages/Compare'
import { Evolve } from './pages/Evolve'
import { Experiments } from './pages/Experiments'
import { Pareto } from './pages/Pareto'
import { Placeholder } from './pages/Placeholder'
import { Register } from './pages/Register'
import { ResetPassword } from './pages/ResetPassword'
import { Sensitivity } from './pages/Sensitivity'
import { Simulate } from './pages/Simulate'
import { Verify } from './pages/Verify'

// Every FEATURES page has been migrated (Phase 3: Simulate, Evolve; Phase 4:
// the rest). The Placeholder only renders if a feature path is ever added
// here without a page.
const MIGRATED: Record<string, () => JSX.Element> = {
  '/simulate': Simulate,
  '/evolve': Evolve,
  '/pareto': Pareto,
  '/sensitivity': Sensitivity,
  '/active-learning': ActiveLearning,
  '/compare': Compare,
  '/experiments': Experiments,
}

/** Route table; the Router itself is provided by main.tsx (or a MemoryRouter in tests). */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        {/* `/guide`, not `/docs` -- see features.ts's PUBLIC_NAV_LINKS comment: */}
        {/* FastAPI's own Swagger UI already owns `/docs` in production. */}
        <Route path="/guide" element={<Docs />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify" element={<Verify />} />
        {FEATURES.map((f) => {
          const Page = MIGRATED[f.path]
          return (
            <Route
              key={f.path}
              path={f.path}
              element={<RequireAuth>{Page ? <Page /> : <Placeholder feature={f} />}</RequireAuth>}
            />
          )
        })}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
