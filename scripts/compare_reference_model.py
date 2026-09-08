"""Compare our simulator against the reference model's generations-to-
senescence distribution (SDD §22 Level 3). MIT-licensed; never imports the
GPLv3 reference package. See scripts/reference_model/README.md.

    python scripts/compare_reference_model.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.schemas import ModelConfig  # noqa: E402
from telomere_lab.simulator.metrics import hayflick_distribution  # noqa: E402
from telomere_lab.simulator.model import SimpleTelomereModel  # noqa: E402

REF_JSON = Path(__file__).resolve().parents[1] / "experiments" / "reference_model" / "reference_hayflick.json"
OUT_JSON = Path(__file__).resolve().parents[1] / "experiments" / "reference_model" / "ours_hayflick.json"

#: Matched to scripts/reference_model/run_reference_hayflick.py: same
#: founder count and seed; pure replicative shortening (no maintenance, no
#: stress) since the reference model has no telomerase term at all.
OUR_CONFIG = ModelConfig(
    population_size=80, carrying_capacity=20000, telomeres_per_cell=32,
    maintenance_rate=0.0, stress_level=0.0, noise_sd=30.0,
    shortening_rate=55.0, senescence_threshold=3000.0, initial_length=7500.0,
    initial_length_sd=800.0, cycles=150, seed=11,
)


def summarise(name: str, observed: np.ndarray, n_censored: int) -> None:
    n = len(observed) + n_censored
    cv = observed.std() / observed.mean() if observed.size and observed.mean() else float("nan")
    print(f"{name}")
    print(f"  n={n}  observed={len(observed)}  censored={n_censored}")
    if observed.size:
        print(f"  mean={observed.mean():.2f}  median={np.median(observed):.2f}  "
              f"std={observed.std():.2f}  cv={cv:.3f}  min={observed.min():.0f}  max={observed.max():.0f}")


def main() -> int:
    result = SimpleTelomereModel().simulate(OUR_CONFIG)
    if not result.valid:
        print(f"our simulation failed: {result.failure_reason}", file=sys.stderr)
        return 2
    ours_observed = result.founder_senescence_cycle[result.founder_senescence_cycle >= 0]
    ours_censored = int((result.founder_senescence_cycle < 0).sum())
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({
        "seed": OUR_CONFIG.seed, "n_founders": OUR_CONFIG.population_size,
        "generations_at_senescence": ours_observed.tolist(), "n_censored": ours_censored,
    }, indent=2), encoding="utf-8")

    summarise("OURS  (SimpleTelomereModel, maintenance=0, stress=0)", ours_observed, ours_censored)
    print(f"  hayflick_distribution(): {hayflick_distribution(result.founder_senescence_cycle)}")

    if not REF_JSON.exists():
        print(f"\nReference data not found at {REF_JSON}.")
        print("Generate it first: see scripts/reference_model/README.md")
        return 0

    ref = json.loads(REF_JSON.read_text(encoding="utf-8"))
    ref_observed = np.array(ref["generations_at_senescence_or_death"])
    print(f"\nREFERENCE  (anais-rat/telomeres, population_evolution, default best-fit params)")
    summarise("", ref_observed, ref["n_censored"])
    print(f"\nNote: absolute generation counts are NOT comparable (different organism, telomere "
          f"length scale, and senescence mechanism - see scripts/reference_model/README.md). "
          f"The comparison is about distribution SHAPE: CV, skew, censoring.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
