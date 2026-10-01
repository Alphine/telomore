# Frontend access modes: live vs demo

Compute on the API is limited to **Pro** accounts granted by an admin (`../docs/ADMIN.md`). Everybody else
still gets to see every feature, driven by **precomputed scenarios** that ship with the static site
(`<BASE>/demo-cache/`, produced by `scripts/build_demo_cache.py`, contract in `../docs/DEMO_CACHE.md`).

## Who sees what

| Visitor | Mode | Feature pages | Run button |
|---|---|---|---|
| anonymous | demo | scenario picker, locked form, cached results | none (CTA: Log in) |
| free account | demo | same | none (CTA: Request Pro access) |
| pro / admin | live (default) | the normal page, as before | calls the API |
| pro / admin | demo (toggle) | same as above, flipped on a Live/Demo switch | none |

`/account` (login required) shows the plan, expiry, the access-request form (message up to 500 chars) and the
status of earlier requests. `/admin/*` is a lazy chunk behind `RequireAdmin`; anybody who is not an admin sees the
same 404 page as for an unknown URL.

## Moving parts

| File | Role |
|---|---|
| `src/access/context.ts` | `useAccess()` -> `{status, user, plan, isAdmin, canLive, mode, preferredMode, setPreferredMode, reportProRequired}`; `derivePlan()` (an expired pro plan counts as free). Inert default outside a provider (= demo). |
| `src/access/AccessProvider.tsx` | Mounted inside `AuthProvider`. Remembers the Live/Demo choice (`localStorage tel_mode`), listens for the `tel:pro-required` window event and forces demo until the account says otherwise. |
| `src/api/client.ts` | Throws `ApiError` as before. A `403 {detail:{code:'pro_required'}}` additionally dispatches `tel:pro-required`; `ApiError.message` becomes a friendly sentence. While `demoHooks.active` is set, compute paths never reach `fetch`: they are answered by `demo/replay.ts` or refused locally with `403 {code:'demo_mode'}`. |
| `src/demo/FeatureGate.tsx` | Route wrapper. Waits for the session, then renders the page live, or inside `DemoProvider`. Remounts the page when the mode flips. |
| `src/demo/DemoProvider.tsx` | Fetches `index.json`, lists the feature's scenarios, loads the selected one, and raises `demoHooks.active` (synchronously, before children mount). Failures are not cached; the picker shows Retry. |
| `src/demo/cache.ts` | `demoUrl`, `fetchDemoIndex`, `fetchDemoScenario` (`?v=<sha10>`), `scenariosFor`. |
| `src/demo/replay.ts` | Local answers for job polling (`GET /jobs/demo:<id>` -> a completed synthetic job), the experiments ledger, genome data and the scenario's own POST endpoint. |
| `src/demo/ModePanel.tsx` | Rendered by `PageHeader`: the "Precomputed example – not live compute" banner + CTA, the scenario cards, a read-only view of the request, or the "Live mode" bar with the switch. Renders nothing outside a `FeatureGate`. |
| `src/components/DemoForm.tsx` | Drop-in `<form>`. In demo mode it is a `<fieldset disabled>` with a "read-only" note and a no-op submit. |
| `src/demo/context.ts` | `useIsDemo()`, `useDemoScenario<Req, Res>()`. |

## Adding a feature to demo mode

1. **Cache.** Add the scenarios in `scripts/build_demo_cache.py` under the feature's route slug
   (the key in `index.json`'s `features`, equal to the route path without `/`). The scenario file is
   `{id, title, description, feature, endpoint, request, response, meta, extra}` where `request` is the exact API
   body and `response` the exact API reply (for background jobs: the finished job's `result`).
2. **Route.** In `src/App.tsx` the route is wrapped by `FeatureGate` automatically for every entry of
   `FEATURES`; give the page its lazy loader in `MIGRATED`. Do not wrap it in `RequireAuth`.
3. **Page.** Three small changes inside the page component:
   - use `PageHeader` (it renders the mode panel),
   - replace the main `<form>` by `<DemoForm>` (same props, controls become read-only in demo mode),
   - seed the page state from the scenario:

   ```tsx
   const demoSc = useDemoScenario<MyRequest, MyResult>()
   useEffect(() => {
     if (!demoSc || !bounds) return
     setBase({ ...bounds.demo, ...demoSc.request.model })   // fill the locked form
     setLive([])
     setJobId(DEMO_JOB_PREFIX + demoSc.id)                  // job pages: replayed as a completed job
     // single-shot pages: setResult(demoSc.response) instead
   }, [demoSc, bounds, ...stableSetters])
   ```

   Merge partial requests over the defaults from `/meta/bounds`; scenario requests are what was sent, not a full form state.
4. **Pages that load data on mount** (ledger, genome) cannot be seeded from state: list their slug in
   `WAIT_FOR_SCENARIO` in `FeatureGate.tsx` (the page mounts once the scenario is loaded and remounts per scenario) and teach
   `replay.ts` the GET/POST calls the page makes.
5. **Tests.** See `src/pages/DemoPages.test.tsx` (Simulate = single-shot, Sensitivity = job page) and
   `src/demo/FeatureGate.test.tsx`.

## Pro users: the 403 path

If the API answers `403 pro_required` (plan expired or revoked while the page was open) the gate switches to demo,
shows a toast and re-reads `/auth/me`. The error never reaches the page as an exception it has to handle; the page
simply remounts in demo mode. A change of plan (new `plan` / `plan_expires_at` / `is_admin`) lifts the lock.

## Local development with mocks

`dev-mocks/server.mjs` fakes the API (users `free`, `pro`, `admin`, `expired`; any password) and serves a demo-cache
directory; `dev-mocks/admin-fixtures.mjs` provides the admin endpoints with in-memory state. Nothing under
`dev-mocks/` is part of `dist/`.

```bash
cd frontend
DEMO_CACHE_DIR=/path/to/demo-cache PORT=5190 node dev-mocks/server.mjs &
MOCK_API_PORT=5190 npx vite --port 5181
# then localStorage.setItem('tel_token', 'admin-token') and reload
```

`public/demo-cache/` is generated by `python scripts/build_demo_cache.py` and is not edited by hand.
