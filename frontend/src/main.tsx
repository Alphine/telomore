import { LazyMotion, domAnimation } from 'framer-motion'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App.tsx'
import { AccessProvider } from './access/AccessProvider.tsx'
import { AuthProvider } from './auth/AuthContext.tsx'
import { ToastProvider } from './components/ui/Toast.tsx'
import { applyInitialThemeClass } from './theme/context'
import { ThemeProvider } from './theme/ThemeProvider'
import './index.css'

// Apply the persisted/system theme synchronously, before React mounts, so
// the page never flashes the wrong theme and then flips.
applyInitialThemeClass()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LazyMotion features={domAnimation} strict>
      <ToastProvider>
        {/* basename follows Vite's `base` so the app also works under /telomore/ */}
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
          <AuthProvider>
            <AccessProvider>
              <App />
            </AccessProvider>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
      </LazyMotion>
    </ThemeProvider>
  </StrictMode>,
)
