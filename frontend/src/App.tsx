import { Route, Routes } from 'react-router-dom'

import { RequireAuth } from './auth/RequireAuth'
import { Layout } from './components/Layout'
import { FEATURES } from './features'
import { ForgotPassword } from './pages/ForgotPassword'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
import { Evolve } from './pages/Evolve'
import { Placeholder } from './pages/Placeholder'
import { Register } from './pages/Register'
import { ResetPassword } from './pages/ResetPassword'
import { Simulate } from './pages/Simulate'
import { Verify } from './pages/Verify'

// Pages migrated so far (Phase 3: Simulate, Evolve). Everything else in
// FEATURES still renders the Phase 2 placeholder until Phase 4.
const MIGRATED: Record<string, () => JSX.Element> = {
  '/simulate': Simulate,
  '/evolve': Evolve,
}

/** Route table; the Router itself is provided by main.tsx (or a MemoryRouter in tests). */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
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
