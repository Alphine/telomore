import { Route, Routes } from 'react-router-dom'

import { RequireAuth } from './auth/RequireAuth'
import { Layout } from './components/Layout'
import { FEATURES } from './features'
import { ForgotPassword } from './pages/ForgotPassword'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
import { Placeholder } from './pages/Placeholder'
import { Register } from './pages/Register'
import { ResetPassword } from './pages/ResetPassword'
import { Verify } from './pages/Verify'

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
        {FEATURES.map((f) => (
          <Route
            key={f.path}
            path={f.path}
            element={
              <RequireAuth>
                <Placeholder feature={f} />
              </RequireAuth>
            }
          />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
