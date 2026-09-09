# React frontend (Phase 2 of the Streamlit → React migration)

Vite + React 18 + TypeScript + Tailwind CSS v4 + React Router v6, built
against the FastAPI backend in `../backend/` (contract: `../docs/API.md`).

Phase 2 delivers the scaffold: routing, auth pages (login / register /
verify / forgot- and reset-password), the public landing page ported from
`app/streamlit_app.py`, and a protected shell with placeholder pages for
Simulate / Evolve / Pareto / Sensitivity / Active Learning / Compare /
Experiments (real content lands in Phases 3–4). **The Streamlit app in
`../app/` is still the live production UI** — Railway keeps starting it.

## Run locally

Two terminals, from the repo root:

```bash
# 1. API (SQLite fallback, dev-mode email links -- see docs/API.md)
uvicorn backend.main:app --reload --port 8000

# 2. Frontend dev server (proxies /api -> http://127.0.0.1:8000, see vite.config.ts)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

## Build / test / lint

```bash
cd frontend
npm run build          # tsc -b && vite build  -> frontend/dist/
npm run test           # vitest (jsdom + @testing-library/react)
npm run lint           # oxlint
npm run typecheck      # tsc -b
```

`frontend/dist/` is git-ignored. When it exists, `backend/main.py` serves it
(static `/assets` + SPA fallback to `index.html` for every non-`/api` GET),
so a single `uvicorn backend.main:app` process hosts API + frontend on one
origin — the production shape planned in `docs/ROADMAP.md`. Without a build
the backend behaves exactly as before (API only).

## Layout

```
src/
  api/        client.ts (fetch wrapper, ApiError), endpoints.ts (one fn per
              endpoint), types.ts (mirrors backend/schemas.py), devLinks.ts
  auth/       context.ts (AuthContext + useAuth), AuthContext.tsx (provider),
              RequireAuth.tsx (route guard), safeNext.ts
  components/ Layout (sidebar/top bar), Callout + Disclaimer, DevLink, AuthCard
  pages/      Landing, Login, Register, ForgotPassword, ResetPassword, Verify,
              Placeholder (protected stubs), NotFound
  features.ts FEATURES / NAV order / DISCLAIMER text, copied from the Streamlit app
  test/       vitest setup + helpers (MemoryRouter + AuthProvider, fetch mock)
```

## Auth state

`AuthProvider` (`src/auth/AuthContext.tsx`) holds
`{ token, user, status: 'loading' | 'anonymous' | 'authenticated' }`. On
start, a stored token is only trusted once `GET /api/auth/me` accepts it; a
401/403 clears it. `login()` distinguishes the API's three outcomes: 401 →
wrong credentials, 403 → email not verified (with a verify hint), 200 →
store token, fetch `/me`. `RequireAuth` redirects anonymous users to
`/login?next=<path>` and returns them after login.

**localStorage trade-off.** The JWT is persisted in `localStorage`
(`tel_token`) so a login survives page reloads — a deliberate UX improvement
over the Streamlit app's session-only login. The cost is that any script
running on this origin can read it (XSS), unlike an HttpOnly cookie. This is
acceptable for a research prototype with no third-party scripts; revisit if
the threat model changes.

## Dev-mode email links

Without `RESEND_API_KEY`, the backend returns `dev_verification_link` /
`dev_reset_link` in the register / forgot-password responses, shaped as
`/?token=…` and `/?reset_token=…` (root path + query param, see
`backend/routers/auth.py::_frontend_link`). The frontend maps these onto
`/verify?token=…` and `/reset-password?token=…` — both when rendering them
as clickable dev-mode links (`src/api/devLinks.ts`) and when such a link is
opened directly (the landing route redirects on those query params).
