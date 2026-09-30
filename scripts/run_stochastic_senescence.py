"""CLI: Experiment M -- can the model express heterogeneous (stochastic)
senescence, and how does it compare with the hard threshold?

For the default ModelConfig over many seeds, compares five variants
(hard threshold; hard + shortening_rate_cv; logistic hazard; hazard + cv;
random arrest) on

* dispersion of the senescence-onset timing ACROSS seeds (time to 10% senescent),
* the WIDTH in cycles between 10% and 90% senescent fraction (within a culture),
* population doublings (PD) reached when the culture is 50% senescent.

Qualitative only: nothing here is fitted to data. Writes
``experiments/reports/stochastic_senescence.json``.

    python scripts/run_stochastic_senescence.py
    python scripts/run_stochastic_senescence.py --seeds 60
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import REPORTS_DIR  # noqa: E402
from telomere_lab.experiments.registry import _json_default, environment_metadata  # noqa: E402
from telomere_lab.schemas import ModelConfig  # noqa: E402
from telomere_lab.simulator.metrics import time_to_fraction  # noqa: E402
from telomere_lab.simulator.model import simulate  # noqa: E402

VARIANTS = {
    "hard": {},
    "hard_cv0.3": {"shortening_rate_cv": 0.3},
    "soft300": {"senescence_softness_bp": 300.0},
    "soft300_cv0.3": {"senescence_softness_bp": 300.0, "shortening_rate_cv": 0.3},
    "random_arrest0.02": {"random_arrest_rate": 0.02},
}
CYCLES = 200


def one_run(overrides: dict, seed: int) -> dict:
    res = simulate(ModelConfig(cycles=CYCLES, seed=seed, **overrides))
    frac = np.nan_to_num(res.senescent_fraction, nan=1.0)  # extinct == fully lost
    t10, t50, t90 = (time_to_fraction(frac, q) for q in (0.1, 0.5, 0.9))
    pd_at_50 = float(res.population_doublings[int(t50)]) if np.isfinite(t50) else float("nan")
    return {"seed": seed, "t10": t10, "t50": t50, "t90": t90,
            "width_10_90": (t90 - t10) if np.isfinite(t90) and np.isfinite(t10) else float("nan"),
            "pd_at_50pct": pd_at_50, "total_pd": float(res.terminal_metrics["total_pd"])}


def stats(values) -> dict:
    a = np.asarray([v for v in values if np.isfinite(v)], dtype=float)
    if a.size == 0:
        return {"n": 0, "mean": None, "sd": None, "cv": None}
    return {"n": int(a.size), "mean": float(a.mean()), "sd": float(a.std(ddof=1)) if a.size > 1 else 0.0,
            "cv": float(a.std(ddof=1) / a.mean()) if a.size > 1 and a.mean() != 0 else None}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seeds", type=int, default=40)
    args = ap.parse_args()
    if args.seeds < 30:
        ap.error("--seeds must be >= 30")

    out = {"experiment": "M", "label": "qualitative; not calibrated to any dataset", "cycles": CYCLES,
           "n_seeds": args.seeds, "variants": {}, "environment": environment_metadata()}
    for name, over in VARIANTS.items():
        runs = [one_run(over, s) for s in range(args.seeds)]
        out["variants"][name] = {
            "overrides": over,
            "onset_t10": stats([r["t10"] for r in runs]),
            "t50": stats([r["t50"] for r in runs]),
            "width_10_90": stats([r["width_10_90"] for r in runs]),
            "pd_at_50pct": stats([r["pd_at_50pct"] for r in runs]),
            "censored_t90": int(sum(not np.isfinite(r["t90"]) for r in runs)),
            "runs": runs,
        }
        v = out["variants"][name]
        print(f"{name:20s} onset t10 {v['onset_t10']['mean']:.1f} (SD {v['onset_t10']['sd']:.2f})  "
              f"width {v['width_10_90']['mean']:.1f} (SD {v['width_10_90']['sd']:.2f})  "
              f"PD@50% {v['pd_at_50pct']['mean']:.1f} (SD {v['pd_at_50pct']['sd']:.2f})")

    path = Path(REPORTS_DIR) / "stochastic_senescence.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2, default=_json_default), encoding="utf-8")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
