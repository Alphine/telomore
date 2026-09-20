"""CLI: Experiment K -- a checkpoint-competent ("healthy") clone vs. a
checkpoint-deficient ("damaged") clone in one shared culture.

Runs ``configs/demo_healthy_vs_damaged.yaml`` over several seeds, two neutral
controls (healthy-vs-healthy, damaged-vs-damaged) and a sweep of the shared
``mutation_threshold``, and writes ``experiments/reports/healthy_vs_damaged.json``.

    python scripts/run_healthy_vs_damaged.py
    python scripts/run_healthy_vs_damaged.py --seeds 100
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean, pstdev

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from telomere_lab.config import CONFIG_DIR, REPORTS_DIR, load_model_config  # noqa: E402
from telomere_lab.experiments.registry import _json_default, environment_metadata  # noqa: E402
from telomere_lab.schemas import ModelConfig, SubcloneSpec  # noqa: E402
from telomere_lab.simulator.model import simulate  # noqa: E402

CHECKPOINTS = (0, 50, 100, 150)


def clone_overrides(base: ModelConfig, name: str) -> dict:
    return dict(next(c for c in base.subclones if c.name == name).overrides)


def two_clones(first: dict, second: dict, first_name: str = "A", second_name: str = "B"):
    return (SubcloneSpec(first_name, 0.5, dict(first)), SubcloneSpec(second_name, 0.5, dict(second)))


def measure(cfg: ModelConfig, clone: str, seeds: range) -> dict:
    """Mean/SD of `clone`'s share of the LIVING population at fixed cycles.

    A checkpoint is fixed by simulating each seed; seeds whose culture is extinct
    at that cycle are excluded from that cycle's share (an extinct culture reports
    a clone fraction of 0.0 for every clone, which would bias any mean toward 0),
    and the number of surviving seeds is reported alongside so it is not hidden.
    """
    shares = {c: [] for c in CHECKPOINTS}
    burden, instab, pop = [], [], []
    for s in seeds:
        r = simulate(cfg.replace(seed=s))
        assert r.valid
        frac = r.clone_fraction[clone]
        for c in CHECKPOINTS:
            i = min(c, len(frac) - 1)
            if r.population_size[i] > 0:
                shares[c].append(float(frac[i]))
        burden.append(r.terminal_metrics["final_mutation_burden"])
        instab.append(r.terminal_metrics["genomic_instability_index"])
        pop.append(float(r.population_size[-1]))
    return {
        "share": {str(c): {"mean": mean(v) if v else float("nan"), "sd": pstdev(v) if len(v) > 1 else 0.0,
                           "n_alive": len(v)} for c, v in shares.items()},
        "final_mutation_burden": mean(burden),
        "genomic_instability_index": mean(instab),
        "final_population": mean(pop),
    }


def fmt_share(m: dict) -> str:
    return "  ".join(
        f"c{c}={m['share'][str(c)]['mean']:.2f}+/-{m['share'][str(c)]['sd']:.2f}(n={m['share'][str(c)]['n_alive']})"
        for c in CHECKPOINTS)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seeds", type=int, default=100)
    args = ap.parse_args(argv)
    seeds = range(1, args.seeds + 1)

    base = load_model_config(CONFIG_DIR / "demo_healthy_vs_damaged.yaml")
    healthy, damaged = clone_overrides(base, "healthy"), clone_overrides(base, "damaged")

    results = {}
    print(f"seeds 1..{args.seeds}; shares are the FIRST clone's population share (mean +/- sd across surviving seeds)\n")

    results["healthy_vs_damaged"] = measure(base, "healthy", seeds)
    print("healthy vs damaged  (healthy's share)")
    print("  " + fmt_share(results["healthy_vs_damaged"]))

    for label, ov in (("control_healthy_vs_healthy", healthy), ("control_damaged_vs_damaged", damaged)):
        cfg = base.replace(subclones=two_clones(ov, ov))
        results[label] = measure(cfg, "A", seeds)
        print(f"\n{label}  (clone A's share -- should hover near 0.5, drift only)")
        print("  " + fmt_share(results[label]))

    sweep = {}
    print("\nmutation_threshold sweep (healthy's share; shared by both clones)")
    for thr in (0.10, 0.25, 0.50, 1.00, 1.0e9):
        h, d = dict(healthy, mutation_threshold=thr), dict(damaged, mutation_threshold=thr)
        cfg = base.replace(subclones=(SubcloneSpec("healthy", 0.5, h), SubcloneSpec("damaged", 0.5, d)))
        sweep[str(thr)] = measure(cfg, "healthy", seeds)
        print(f"  threshold={thr:<10g} " + fmt_share(sweep[str(thr)])
              + f"   final_burden={sweep[str(thr)]['final_mutation_burden']:.2f}")
    results["threshold_sweep"] = sweep

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / "healthy_vs_damaged.json"
    payload = {"environment": environment_metadata(), "config": base.to_dict(), "seeds": list(seeds),
               "checkpoints": list(CHECKPOINTS), "results": results}
    out.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")
    print(f"\nReport written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
