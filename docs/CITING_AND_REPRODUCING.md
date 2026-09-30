# Citing and reproducing

## How to cite

Until a release DOI exists, cite the repository and the exact commit you used:

> Alphine (TODO(owner): real author name). *Telomere Evolution Lab* (software).
> https://github.com/Alphine/telomore, commit `<git sha>`. MIT licence.

Machine-readable metadata is in [`CITATION.cff`](../CITATION.cff) (GitHub shows
a "Cite this repository" button from it) and [`.zenodo.json`](../.zenodo.json).
Both still contain `TODO(owner)` placeholders (real name, ORCID, affiliation,
version, release date, DOI); see the owner checklist below. Once a DOI is
minted, cite the DOI rather than the bare URL.

Please also state the `model_version` (`telomere_lab.schemas.MODEL_VERSION`,
currently `0.1.0`) and describe results as *model output*, in line with
[`SCIENTIFIC_SCOPE.md`](SCIENTIFIC_SCOPE.md).

## Reproducing a run

Every simulation is a deterministic function of its configuration and seed.
The ledger records what is needed to repeat it.

1. **Ledger.** Each recorded run gets an id `TEL-YYYYMMDD-NNN`. A one-line index
   is appended to `experiments/registry.jsonl` (tracked in git); the full
   `record.json` and artifacts live under `experiments/runs/<run_id>/`
   (git-ignored, so only present on the machine that ran it). See
   `src/telomere_lab/experiments/registry.py`.
2. **What a record holds:** `run_id`, `kind`, `seed`, the full `configuration`
   (model parameters plus fitness weights), `configuration_hash` (a hash of that
   whole configuration, including weights), `model_version`,
   `optimizer_version`, `git_commit` (suffixed `-dirty` if the tree had
   uncommitted changes), and an `environment` block (Python, NumPy, SciPy,
   pandas versions).
3. **Re-run.** Take `configuration.model` from `record.json`, rebuild the
   config with `ModelConfig.from_dict(...)`, and call `simulate(cfg)`; or use
   `scripts/run_simulation.py --config ... --seed ...`. With the same
   `model_version`, seed and configuration, the same trajectories result
   (a `to_dict` / `from_dict` round trip preserves `ModelConfig.config_hash()`).
   For exact identity also check out the recorded `git_commit` and match the
   recorded library versions, since NumPy random-stream behaviour is a
   dependency.
4. **Golden fixtures.** `tests/fixtures/simulator_golden_v0.1.0.npz` and
   `tests/fixtures/evolution_golden_v0.1.0.json` are output of the model
   frozen at v0.1.0. Tests (e.g. `tests/test_genome_stability.py`,
   `tests/test_schedule.py`) require new code to reproduce them bit for bit
   when new features are switched off. If your checkout fails these tests, it
   is not the model that was published.
5. **Experiments.** Every number in
   [`EXPERIMENT_PROTOCOL.md`](EXPERIMENT_PROTOCOL.md) comes from a recorded
   run; the experiment sections give the run id and/or the command to repeat it.

Note that the `config_hash()` of a `ModelConfig` (used for caching) and the
ledger's `configuration_hash` (which covers the whole configuration dict) are
different hashes and are not interchangeable.

## How the pieces relate

| Piece | What it is |
|---|---|
| Python package `src/telomere_lab/` | The model, optimisers and ledger. The only source of results. |
| FastAPI backend `backend/` | Serves the package over HTTP. All compute runs here (deployed on Railway). |
| https://studylab.id/telomore/ | Static React build of `frontend/`; every API call goes to the Railway backend. |
| https://telomore-production.up.railway.app/ | The same app served by FastAPI itself. |
| https://studylab.id/foci/ | Foci Lab: a separate static site with real 53BP1 microscopy from a published screen (IDR idr0010). It does not call the simulator; its automated counter is unvalidated (Experiment L). |

To reproduce or cite results, use the Python package and the ledger, not the
websites.

## Owner release checklist (not yet done)

These are steps for the repository owner; nothing here has been performed.

1. Enable the Zenodo-GitHub integration: sign in to zenodo.org with GitHub and
   switch on the `Alphine/telomore` repository.
2. Fill every `TODO(owner)` in `CITATION.cff` and `.zenodo.json`: real given and
   family names, ORCID (or remove the field), affiliation, `version`,
   `date-released`. Zenodo may reject a placeholder ORCID, so remove it if you
   do not have one. Keep the version consistent with `pyproject.toml`.
3. Commit, then tag and publish a GitHub release (for example `v0.1.0`). Zenodo
   then archives it and mints a DOI.
4. Add the DOI to `CITATION.cff` (`doi:`), add the DOI badge to `README.md`, and
   update the citation text above.
