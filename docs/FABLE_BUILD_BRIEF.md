# FABLE_BUILD_BRIEF.md

A ready-to-paste prompt for opening a long-running Claude Fable 5.1 build
session on this repo. Paste the section below the `---` directly as the
first message of that session. The rest of this file (above the `---`) is
context for whoever hands the prompt over, not part of the prompt itself.

This exists because the account owner wants a long, multi-week build
(React migration — done; LLM agentic layers + new simulation features) to
proceed without the session hallucinating APIs that don't exist,
re-deciding things already decided, or shipping bugs that a stricter
process would have caught. Update this file's `---` section whenever a
major decision changes — it should always reflect the CURRENT plan, not a
frozen snapshot. `docs/ROADMAP.md` is the fuller decision log with
rationale; this file is the compressed, actionable brief.

---

You are continuing long-term development on Telomere Evolution Lab, a
personal research/product project (not a one-off hackathon submission —
the owner is actively growing it). Before doing anything else, read these
in full, in this order: `README.md`, `docs/ROADMAP.md` (the living
decision log — this is the source of truth for what's decided and why),
`docs/SDD.md` (original design doc — some of it is superseded by
ROADMAP.md, ROADMAP wins on conflict), `docs/SCIENTIFIC_SCOPE.md` (the
language/claims discipline you must follow in any user-facing text you
write), `docs/MODEL.md`, `docs/EXPERIMENT_PROTOCOL.md`. Then run
`git log --oneline -20` and `git status --short` to see exactly what
state the repo is actually in — do not trust this brief's description of
"current state" over what git actually shows, since this brief can go
stale between sessions.

## Non-negotiable operating rules

These exist because of specific failures earlier in this project's
history — follow them exactly, they are not stylistic preferences.

1. **Never assume an API, function, or file exists — verify by reading or
   grepping first.** If you reference `db.create_user(...)` or any other
   existing function, you must have actually read its current signature
   in this session, not recalled it from training or from this brief's
   prose description. This brief and ROADMAP.md describe intent; the code
   is the only ground truth.
2. **Read before you edit. Every file you modify, read in full first**,
   not just the diff region — this codebase has established conventions
   (dataclasses, type hints, minimal comments, specific test patterns)
   that only show up by reading the whole file.
3. **Run `python -m pytest` after every meaningful change** and do not
   consider a task done until the full suite passes. If you're an
   orchestrator delegating to sub-agents, **independently re-verify their
   test-pass claims yourself** (re-run pytest, don't just trust a
   sub-agent's self-reported summary) before reporting success upward or
   moving to the next phase — this project has caught agents
   over-reporting success before.
4. **One coherent git commit per feature/phase, never amend, never
   force-push, never push without being asked.** Commit locally, let the
   human review and push. Every commit message ends with:
   `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (or the
   equivalent for whichever model is actually authoring — check the
   live attribution instruction in your own session, this brief may be
   stale on the exact wording).
5. **Never run two agents/sessions against the same files concurrently.**
   This project hit real file-clobbering bugs from exactly that. If you
   are orchestrating sub-agents, sequence work that touches overlapping
   files; only parallelize genuinely disjoint file sets.
6. **Do not touch `src/telomere_lab/simulator/` or `evolution/` core
   algorithms as a side effect of unrelated work.** These are the
   validated scientific core (tested against a published reference
   model). Changes here need to be the explicit point of the task, not
   incidental.
7. **The deployed UI is the React app served by FastAPI (`Dockerfile`).**
   Any backend change must keep `python -m pytest` green AND the frontend
   checks green (`cd frontend && npx tsc -b && npm run lint && npx vitest
   run && npm run build`); an API contract change needs the matching
   `frontend/src/api/types.ts` + page change and a `docs/API.md` update in
   the same commit. (The Streamlit app that this rule used to protect was
   removed in Phase 5, 2026-09-10.)
8. **No hardcoded secrets, ever.** API keys (LLM BYOK, `RESEND_API_KEY`,
   `DATABASE_URL`, `SECRET_KEY`) are environment variables with a
   documented dev-mode fallback (see `src/telomere_lab/db.py` and
   `src/telomere_lab/email.py` for the established pattern — follow it
   for any new secret-requiring feature, including the LLM API key).
9. **Follow the scope-language discipline in `docs/SCIENTIFIC_SCOPE.md`
   for ANY user-facing or LLM-generated text**, especially once the LLM
   interpreter layer exists — its own output is exactly the kind of text
   that policy exists to constrain.
10. **When a decision genuinely needs the human** (a new external
    service/credential, an ambiguous scope call with real cost either
    way, anything destructive/irreversible) — ask, don't guess. Small,
    reversible, in-scope implementation choices (exact CSS values, which
    of two equally-good libraries, internal function names) are yours to
    make; say what you chose and why in your report.
11. **Verify UI changes visually before claiming they work**, not just
    via passing tests — start the app, drive it through a browser tool,
    screenshot/read the actual rendered page.

## Current architecture (verify against `git log`/code before trusting)

- Python backend `src/telomere_lab/`: simulator, GA, NSGA-II, sensitivity
  analysis, optimizer benchmark, surrogate-model active learning
  (Gaussian Process + Expected Improvement), reference-model comparison,
  `db.py` (SQLAlchemy, Postgres via `DATABASE_URL` / SQLite fallback,
  bcrypt auth, email verification, password reset), `email.py` (Resend,
  dev-mode on-screen-link fallback when `RESEND_API_KEY` unset).
- FastAPI backend `backend/` (`main.py` app factory, `auth.py` JWT,
  `jobs.py` in-memory threaded job store with polling, `routers/` one per
  page) — contract in `docs/API.md`. Serves `frontend/dist` when present.
- React frontend `frontend/` (Vite + React 18 + TypeScript + Tailwind v4,
  Plotly charts, WebGL particle canvas) — all seven pages + auth + landing;
  `frontend/README.md`. Tests: Vitest (58), `npx tsc -b`, `oxlint`.
- Deploy: one Railway service built from the repo-root `Dockerfile`
  (node build → `python:3.13-slim` + `uvicorn backend.main:app`),
  `railway.json` on the `DOCKERFILE` builder, healthcheck `/api/health`.
  Env vars: `SECRET_KEY`, `DATABASE_URL`, `RESEND_API_KEY`, `PORT`,
  optional `FRONTEND_BASE_URL` — see `docs/API.md` "Deployment". Railway
  project `earnest-vibrancy`, services `telomore` (app) + `Postgres`.
  Railway CLI is available and authenticated in the dev environment this
  was built in — reuse it for env vars / deploy status rather than asking
  the human to click through the dashboard, unless you're in a different
  environment where it isn't set up.
- The Streamlit GUI (`app/`) is gone (removed 2026-09-10, Phase 5). Docs
  such as `docs/SDD.md` still describe it as history; ROADMAP wins.

## The plan, in order (see `docs/ROADMAP.md` for full rationale on each)

Items 1–5 (FastAPI backend, React scaffold, Simulate + Evolve, remaining
pages, Streamlit removal + Docker/Railway deploy) are **done** — see the
"Completed: Streamlit → React migration" section of `docs/ROADMAP.md`.
Do not re-build them; read `backend/` and `frontend/` instead.

Next, in order:

6. **New simulation feature: time-varying/scheduled intervention
   protocols** (ROADMAP.md candidate-feature #1) — needed both for its
   own narrative value and as a prerequisite for LLM Layer 2 below.
   Touches `schemas.py`, the simulator loop and the optimizers' gene
   encoding, so it is the explicit point of that task (rule 6), plus the
   matching API/React form changes (rule 7).
7. **LLM Layer 1: results interpreter** (read-only narrator over existing
   experiment data — see ROADMAP.md's LLM section for the exact scope and
   the language-policy requirement). BYOK: the key is session-only.
8. **LLM Layer 2: protocol-designing agent** (constrained to proposing
   configs that must pass the same `ModelConfig.validate()` gate as
   everything else — see ROADMAP.md for the full safety-boundary
   argument; do not build this before step 6 exists, there is nothing
   for it to propose into yet).
9. Remaining candidate simulation features from ROADMAP.md (#2-#5),
   ordered by the priority stated there, reassess order with the human
   before starting since new information may have changed priorities by
   then.

## Before you start a new phase

Re-read `docs/ROADMAP.md` in case it was updated since this brief was
last synced (check both files' content, not just modification dates —
diverge-detection by reading, not by trusting timestamps), confirm with
the human if anything looks like it materially changed, and only then
proceed.
