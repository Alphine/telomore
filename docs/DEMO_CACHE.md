# Demo cache

Free / anonymous visitors see a **fully precomputed demo**: static JSON served from
the static host (`https://studylab.id/telomore/demo-cache/...`). Only admin-approved
Pro users run the engine live on Railway. This page documents how the cache is
built, what it contains and how to host it.

Everything in the cache is a **precomputed example run of the model with fixed
seeds** -- not patient data and not a prediction (see `SCIENTIFIC_SCOPE.md`).
Every scenario description says so.

## Layout (contract with the frontend)

```
frontend/public/demo-cache/
  index.json
  simulate/<id>.json        # single runs AND ensembles (see `endpoint`)
  evolve/<id>.json
  pareto/<id>.json
  sensitivity/<id>.json
  gxe/<id>.json
  active-learning/<id>.json
  compare/<id>.json
  experiments/demo-ledger.json
  genome/<id>.json
```

Feature keys equal the route slugs in `frontend/src/features.ts`.

`index.json`:

```json
{"version": 1, "generated_at": "ISO", "engine_version": "telomere_lab 0.1.0 (model ..., optimizer ...)",
 "features": {"simulate": [{"id": "...", "title": "...", "description": "...", "file": "simulate/<id>.json",
                            "endpoint": "/simulate", "bytes": 12345, "sha": "<sha256>", "version": "<sha10>"}]}}
```

Fetch a scenario as `<base>/<file>?v=<version>` (the 10-hex-char prefix of `sha`) so a CDN /
browser can cache it as immutable and still pick up a rebuilt file.

Scenario file:

```json
{"id", "title", "description", "feature", "endpoint", "request": {...}, "response": {...},
 "meta": {"seed": 42, "engine_version": "...", "config_hash": "..."}, "extra": {...}}
```

* `request` is the exact body sent to the live API; `response` is the exact body the
  live API returned (for background jobs: the `result` of the finished
  `GET /api/jobs/{id}`, i.e. what the result views already consume).
* `endpoint` tells the frontend which view / response type applies (`/simulate`,
  `/simulate/ensemble`, `/evolve`, `/pareto`, `/sensitivity`, `/gxe`, `/active-learning`,
  `/compare`, `/sequence/lineage`, ...).
* `meta.config_hash` is `ModelConfig.config_hash()` of the base model config
  (`"n/a"` when the scenario has none).
* Two features bundle several endpoints in one file:
  * `genome/toy-genome`: `response = {"genome": <GET /sequence/genome>, "mutations": [<POST /sequence/mutate> ...]}`,
    `request = {"mutations": [{gene, position, alt}, ...]}`. The other genome scenarios are plain
    `/sequence/lineage` request/response pairs.
  * `experiments/demo-ledger`: `response` = the `GET /experiments?mine=false` list;
    `extra.details[run_id]` = the `GET /experiments/{run_id}` body for each row. Artifact
    downloads are not available in the demo.

### Normalisation (what differs from a raw live response)

Only things that cannot be reproduced are changed:

* `runtime_seconds` and the per-generation `elapsed_seconds` are `0.0` everywhere (wall clock).
* ledger `run_id` becomes `DEMO-<feature>-<id>`; ledger `created_at` is a fixed 2026-01-01 stamp;
  `git_commit` is `null`; host / python / library versions in `environment` are `null`;
  artifact paths are relative placeholders.
* floats are rounded to 5 significant digits; `NaN`/`inf` become `null` (as the live API does).
* JSON is written with sorted keys and compact separators.

## Regenerating

```
python scripts/build_demo_cache.py            # rebuild everything in place
python scripts/build_demo_cache.py --only simulate,compare   # partial rebuild
python scripts/build_demo_cache.py --out /tmp/x              # elsewhere (tests do this)
```

The script drives the real FastAPI app with `TestClient` (env `TELOMERE_REQUIRE_PRO=0`,
`TELOMERE_DISABLE_LIMITS=1`, temp SQLite DB, temp experiment ledger, a throwaway verified
user). It never touches `data/local.db` or `experiments/runs`. A full build takes a few minutes.

It is **idempotent**: running it twice yields byte-identical files (`index.json` keeps its
old `generated_at` when no content changed). `tests/test_demo_cache.py` enforces this and re-runs one
cheap scenario per feature live to prove the stored response equals a fresh run.

**Rebuild whenever** the model or optimizer changes (any change to `src/telomere_lab/simulator`,
`evolution`, `analysis`, `sequence`, fitness weights, `MODEL_VERSION`/`OPTIMIZER_VERSION`), a response
shape in `backend/schemas.py` or the routers changes, or a `config_hash` of a preset changes. Commit
the regenerated files. The determinism test fails when a cached scenario no longer matches the engine.

## Size budget

* total under about 15 MB, every file under 1.5 MB (enforced by the tests);
* current build is about 1 MB uncompressed and gzips well (repetitive numeric arrays).

Adding a scenario: append an `add(...)` call in `scripts/build_demo_cache.py`, keep populations small
(`FAST` base), rebuild, check sizes.

## Hosting notes

* Static files only -- no server logic. Serve `demo-cache/` under the site root with
  `Content-Type: application/json` and gzip/brotli enabled.
* Files are immutable per content (`?v=<sha10>`), so a long cache lifetime
  (`Cache-Control: public, max-age=31536000, immutable`) is safe for scenario files. Keep `index.json`
  on a short lifetime (minutes) because it is the pointer to the current versions.
* `frontend/public/` is copied into `frontend/dist/` by Vite, so the same files ship in the Railway image and
  in the Hostinger upload.
