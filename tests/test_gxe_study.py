"""Genotype x Environment (G×E) reaction-norm study (docs/ROADMAP.md
2026-09-13 follow-up to Genome Stability).

Real simulator dynamics don't reliably produce a large, seed-robust fitness
crossover between two hand-picked genotype/environment configs (verified
empirically: the maintenance-vs-repair tradeoff crosses, but by a margin so
thin it flips sign across different eval_seeds). So the reranking-detection
tests below monkeypatch ``analysis.gxe._evaluate_cell`` with a deterministic
lookup table instead of relying on real simulator arithmetic to happen to
cross -- this tests the reranking LOGIC exactly, without being at the mercy
of whether a hand-tuned genotype pair happens to cross under this model's
particular dynamics. The shape/determinism/evaluations-count/ConfigError
tests use real dynamics (a small FAST config), matching test_sensitivity.py.
"""

import pytest

from telomere_lab.analysis.gxe import run_gxe_analysis
import telomere_lab.analysis.gxe as gxe_module
from telomere_lab.evolution.fitness import FitnessBreakdown
from telomere_lab.schemas import (
    ENVIRONMENT_OVERRIDABLE_PARAMETERS,
    GXE_MAX_CELLS,
    ConfigError,
    EnvironmentSpec,
    GenotypeSpec,
    GxEConfig,
    ModelConfig,
)

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3,
                   maintenance_rate=0.10, repair_rate=0.10)

GENOTYPES = (GenotypeSpec("A", {}), GenotypeSpec("B", {"maintenance_rate": 0.5}))
ENVIRONMENTS = (EnvironmentSpec("env1", {"stress_level": 0.3}), EnvironmentSpec("env2", {"stress_level": 0.7}))


def _fake_breakdown(value: float) -> FitnessBreakdown:
    return FitnessBreakdown(total=value, survival=value, reserve=0.0, senescence=0.0,
                            instability=0.0, cost=0.0, genome_instability=0.0, canalization=1.0,
                            valid=True)


def _patch_cells(monkeypatch, table):
    def fake_evaluate_cell(model, base_config, genotype, environment, weights, eval_seeds):
        return _fake_breakdown(table[(genotype.name, environment.name)])
    monkeypatch.setattr(gxe_module, "_evaluate_cell", fake_evaluate_cell)


# --------------------------------------------------------------- reranking
def test_deliberate_crossover_is_detected(monkeypatch):
    # A beats B in env1 (1.0 > 0.5); B beats A in env2 (1.0 > 0.0) -- a clean sign flip.
    _patch_cells(monkeypatch, {("A", "env1"): 1.0, ("A", "env2"): 0.0,
                              ("B", "env1"): 0.5, ("B", "env2"): 1.0})
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1,))
    result = run_gxe_analysis(FAST, cfg)
    assert result.reranking_pairs == [("A", "B")]
    by_cell = {(it.genotype, it.environment): it.fitness for it in result.items}
    assert by_cell[("A", "env1")] == pytest.approx(1.0)
    assert by_cell[("B", "env2")] == pytest.approx(1.0)


def test_no_crossover_when_one_genotype_always_wins(monkeypatch):
    _patch_cells(monkeypatch, {("A", "env1"): 1.0, ("A", "env2"): 0.8,
                              ("B", "env1"): 0.5, ("B", "env2"): 0.2})
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1,))
    result = run_gxe_analysis(FAST, cfg)
    assert result.reranking_pairs == []


def test_reranking_ignores_nan_cells(monkeypatch):
    # An invalid (NaN) cell must not be treated as a comparable sign.
    _patch_cells(monkeypatch, {("A", "env1"): 1.0, ("A", "env2"): float("nan"),
                              ("B", "env1"): 0.5, ("B", "env2"): 0.9})
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1,))
    result = run_gxe_analysis(FAST, cfg)
    assert result.reranking_pairs == []


# ------------------------------------------------------------------ shape
def test_to_frame_shape_and_row_count():
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1,))
    result = run_gxe_analysis(FAST, cfg)
    df = result.to_frame()
    assert list(df.columns) == ["genotype", "environment", "fitness", "survival", "senescence", "canalization"]
    assert len(df) == len(GENOTYPES) * len(ENVIRONMENTS)
    assert set(df["genotype"]) == {"A", "B"}
    assert set(df["environment"]) == {"env1", "env2"}


def test_json_export_includes_reranking_and_evaluations():
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1, 2))
    result = run_gxe_analysis(FAST, cfg)
    payload = result.to_json_dict()
    assert "reranking_pairs" in payload
    assert payload["evaluations"] == len(GENOTYPES) * len(ENVIRONMENTS) * 2
    assert len(payload["items"]) == len(GENOTYPES) * len(ENVIRONMENTS)


def test_deterministic_given_fixed_seeds():
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1, 2, 3))
    a = run_gxe_analysis(FAST, cfg)
    b = run_gxe_analysis(FAST, cfg)
    assert a.to_frame().equals(b.to_frame())
    assert a.reranking_pairs == b.reranking_pairs


def test_evaluations_counted():
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1, 2))
    result = run_gxe_analysis(FAST, cfg)
    # 2 genotypes x 2 environments x 2 seeds = 8
    assert result.evaluations == 8


# --------------------------------------------------------------- validation
def test_invalid_config_rejected():
    with pytest.raises(ConfigError):  # no genotypes
        GxEConfig(genotypes=(), environments=ENVIRONMENTS).validate()
    with pytest.raises(ConfigError):  # no environments
        GxEConfig(genotypes=GENOTYPES, environments=()).validate()
    with pytest.raises(ConfigError):  # duplicate genotype names
        GxEConfig(genotypes=(GenotypeSpec("A", {}), GenotypeSpec("A", {})), environments=ENVIRONMENTS).validate()
    with pytest.raises(ConfigError):  # duplicate environment names
        GxEConfig(genotypes=GENOTYPES,
                 environments=(EnvironmentSpec("e", {}), EnvironmentSpec("e", {}))).validate()
    with pytest.raises(ConfigError):  # empty eval_seeds
        GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=()).validate()


def test_genotype_and_environment_override_keys_are_not_interchangeable():
    with pytest.raises(ConfigError):  # stress_level is environment-only
        GenotypeSpec("bad", {"stress_level": 0.5}).validate()
    with pytest.raises(ConfigError):  # maintenance_rate is genotype-only
        EnvironmentSpec("bad", {"maintenance_rate": 0.5}).validate()
    assert ENVIRONMENT_OVERRIDABLE_PARAMETERS == ("stress_level",)


def test_grid_size_cap_enforced():
    too_many_genotypes = tuple(GenotypeSpec(f"g{i}", {}) for i in range(GXE_MAX_CELLS + 1))
    with pytest.raises(ConfigError, match="exceeds the cap"):
        GxEConfig(genotypes=too_many_genotypes, environments=(EnvironmentSpec("e", {}),)).validate()


# ------------------------------------------------------------------ roundtrip
def test_roundtrip_and_backward_compatible_from_dict():
    cfg = GxEConfig(genotypes=GENOTYPES, environments=ENVIRONMENTS, eval_seeds=(1, 2))
    d = cfg.to_dict()
    again = GxEConfig.from_dict(d)
    assert again.genotypes == cfg.genotypes
    assert again.environments == cfg.environments
    assert again.eval_seeds == cfg.eval_seeds
