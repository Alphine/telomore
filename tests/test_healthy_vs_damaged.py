"""Healthy-vs-damaged clone scenario (Experiment K, configs/demo_healthy_vs_damaged.yaml).

A checkpoint-competent clone and a checkpoint-deficient clone share one culture
(sub-clone override of the genome-stability parameters, docs/MODEL.md §2.2 + §2.3).
Direction-of-effect tests only -- the exact numbers live in the experiment report.
"""

import numpy as np

from telomere_lab.config import CONFIG_DIR, load_model_config
from telomere_lab.schemas import SubcloneSpec
from telomere_lab.simulator.model import simulate

SEEDS = range(1, 9)


def preset():
    return load_model_config(CONFIG_DIR / "demo_healthy_vs_damaged.yaml")


def test_preset_loads_and_validates():
    cfg = preset().validate()
    assert [c.name for c in cfg.subclones] == ["healthy", "damaged"]
    healthy, damaged = (dict(c.overrides) for c in cfg.subclones)
    assert healthy["checkpoint_strength"] > 0.0
    assert damaged["checkpoint_strength"] == 0.0
    assert damaged["replication_error_rate"] > healthy["replication_error_rate"]


def test_checkpoint_deficient_clone_displaces_the_healthy_clone():
    """No fitness cost of burden exists in the model, so only the checkpoint ever culls:
    by the end the damaged clone holds essentially the whole surviving population."""
    cfg = preset()
    end_healthy = []
    for s in SEEDS:
        r = simulate(cfg.replace(seed=s))
        assert r.valid
        assert r.population_size[-1] > 0
        end_healthy.append(r.clone_fraction["healthy"][-1])
    assert np.mean(end_healthy) < 0.1


def test_without_a_checkpoint_the_two_clones_are_neutral():
    """Control: same clones with the checkpoint effectively unreachable (huge threshold)
    must not systematically favour either clone -- burden alone has no fitness effect."""
    base = preset()
    healthy, damaged = (dict(c.overrides, mutation_threshold=1.0e9) for c in base.subclones)
    cfg = base.replace(subclones=(SubcloneSpec("healthy", 0.5, healthy), SubcloneSpec("damaged", 0.5, damaged)))
    shares = []
    for s in range(1, 25):
        r = simulate(cfg.replace(seed=s))
        if r.population_size[100] > 0:
            shares.append(r.clone_fraction["healthy"][100])
    assert 0.35 < float(np.mean(shares)) < 0.65


def test_damaged_clone_accumulates_more_burden_than_healthy_when_run_alone():
    """The 'damaged' parameters really do produce a higher mutation burden per division."""
    cfg = preset()
    burdens = {}
    for name in ("healthy", "damaged"):
        ov = dict(next(c for c in cfg.subclones if c.name == name).overrides, mutation_threshold=1.0e9)
        solo = cfg.replace(subclones=(SubcloneSpec(name, 0.5, ov), SubcloneSpec("other", 0.5, dict(ov))))
        burdens[name] = simulate(solo.replace(seed=3)).terminal_metrics["final_mutation_burden"]
    assert burdens["damaged"] > 1.5 * burdens["healthy"]
