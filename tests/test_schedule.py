"""Piecewise-constant intervention schedules (docs/MODEL.md §2.1).

The golden fixtures in ``tests/fixtures/`` were produced by the code at
commit 85f030f, *before* schedules existed, so the bit-identity tests below
prove that an unscheduled config (and a ``phases=1`` schedule) still runs the
exact same model.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from telomere_lab.analysis.sensitivity import run_sensitivity_analysis
from telomere_lab.config import load_evolution_config, load_model_config
from telomere_lab.evolution.engine import EvolutionEngine
from telomere_lab.evolution.fitness import compute_fitness, intervention_cost
from telomere_lab.evolution.genome import GenomeSpec, split_gene_name
from telomere_lab.evolution.multiobjective import NSGA2Engine
from telomere_lab.evolution.surrogate import run_active_learning
from telomere_lab.schemas import (
    MAX_PHASES,
    PARAMETER_BOUNDS,
    SCHEDULABLE_PARAMETERS,
    ActiveLearningConfig,
    ConfigError,
    EvolutionConfig,
    FitnessWeights,
    InterventionSchedule,
    ModelConfig,
    MultiObjectiveConfig,
    SensitivityConfig,
    phase_index,
)
from telomere_lab.simulator.model import simulate

FIXTURES = Path(__file__).parent / "fixtures"
FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3)
GENES = ("stress_level", "maintenance_rate", "repair_rate")


def golden_config(seed: int) -> ModelConfig:
    return ModelConfig(population_size=30, carrying_capacity=90, telomeres_per_cell=8, cycles=40, seed=seed,
                       stress_level=0.6, maintenance_rate=0.3, repair_rate=0.25)


def alternating(high: float, low: float, phases: int = 6) -> tuple:
    return tuple(high if k % 2 == 0 else low for k in range(phases))


# --------------------------------------------------------------------- schema
def test_schedule_validation():
    ok = InterventionSchedule(phases=2, values={"stress_level": (0.1, 0.9)})
    assert ok.validate() is ok
    with pytest.raises(ConfigError):
        InterventionSchedule(phases=0, values={}).validate()
    with pytest.raises(ConfigError):
        InterventionSchedule(phases=MAX_PHASES + 1, values={}).validate()
    with pytest.raises(ConfigError):  # wrong length
        InterventionSchedule(phases=3, values={"stress_level": (0.1, 0.9)}).validate()
    with pytest.raises(ConfigError):  # out of bounds
        InterventionSchedule(phases=2, values={"repair_rate": (0.1, 1.5)}).validate()
    with pytest.raises(ConfigError):  # not finite
        InterventionSchedule(phases=2, values={"repair_rate": (0.1, float("nan"))}).validate()
    with pytest.raises(ConfigError):  # unknown / non-schedulable key
        InterventionSchedule(phases=2, values={"shortening_rate": (50.0, 60.0)}).validate()
    # ModelConfig.validate delegates
    with pytest.raises(ConfigError):
        ModelConfig(schedule=InterventionSchedule(2, {"stress_level": (0.1,)})).validate()
    assert set(SCHEDULABLE_PARAMETERS) == {"stress_level", "maintenance_rate", "repair_rate"}


def test_schedule_roundtrip_and_backward_compatible_from_dict():
    cfg = ModelConfig(cycles=60, schedule=InterventionSchedule(3, {"maintenance_rate": (0.0, 0.5, 1.0)}))
    d = cfg.to_dict()
    assert d["schedule"] == {"phases": 3, "values": {"maintenance_rate": [0.0, 0.5, 1.0]}}
    again = ModelConfig.from_dict(json.loads(json.dumps(d)))
    assert again == cfg
    assert again.replace(seed=5).schedule == cfg.schedule
    assert cfg.replace(schedule=None).schedule is None

    old = {k: v for k, v in ModelConfig().to_dict().items() if k != "schedule"}
    legacy = ModelConfig.from_dict(old)
    assert legacy.schedule is None
    assert legacy == ModelConfig()
    assert ModelConfig.from_dict({"cycles": 10}).schedule is None


def test_config_hash_includes_schedule_but_unscheduled_hash_is_unchanged():
    plain = ModelConfig(cycles=50)
    one_phase = plain.replace(schedule={"phases": 1, "values": {"stress_level": [plain.stress_level]}})
    two_phase = plain.replace(schedule={"phases": 2, "values": {"stress_level": [0.2, 0.8]}})
    assert plain.config_hash() != one_phase.config_hash()
    assert one_phase.config_hash() != two_phase.config_hash()
    assert two_phase.config_hash() == two_phase.replace(seed=99).config_hash()
    # unscheduled hash equals the pre-schedule blob (no "schedule" key in it)
    import hashlib
    data = plain.to_dict()
    data.pop("seed")
    data.pop("schedule")
    expected = hashlib.sha256(json.dumps(data, sort_keys=True, default=float).encode()).hexdigest()[:16]
    assert plain.config_hash() == expected


def test_phase_index_edge_cases_including_non_divisible_cycles():
    assert [phase_index(t, 120, 6) for t in (0, 19, 20, 39, 100, 119, 120)] == [0, 0, 1, 1, 5, 5, 5]
    # 10 cycles into 3 phases -> blocks of 4, 3, 3; t == cycles clamps onto the last phase
    assert [phase_index(t, 10, 3) for t in range(11)] == [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2]
    # more phases than cycles: every step still gets a valid phase
    assert [phase_index(t, 3, 8) for t in range(4)] == [0, 2, 5, 7]
    assert all(0 <= phase_index(t, 7, 5) < 5 for t in range(8))
    assert phase_index(5, 100, 1) == 0
    with pytest.raises(ValueError):
        phase_index(0, 0, 3)


def test_value_at_per_cycle_and_mean_value():
    cfg = ModelConfig(cycles=10, stress_level=0.4, maintenance_rate=0.2,
                      schedule=InterventionSchedule(3, {"stress_level": (0.0, 0.5, 1.0)}))
    assert [cfg.value_at("stress_level", t) for t in range(11)] == \
        [0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0, 1.0, 1.0, 1.0]
    np.testing.assert_array_equal(cfg.per_cycle_values("stress_level"),
                                  [0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 1.0, 1.0, 1.0, 1.0])
    # weighted by actual block lengths (4, 3, 3), not the naive mean of the phase values
    assert cfg.mean_value("stress_level") == pytest.approx((4 * 0.0 + 3 * 0.5 + 3 * 1.0) / 10)
    # unscheduled parameter: scalar everywhere
    assert cfg.value_at("maintenance_rate", 7) == 0.2
    assert cfg.mean_value("maintenance_rate") == 0.2
    np.testing.assert_array_equal(cfg.per_cycle_values("maintenance_rate"), np.full(11, 0.2))
    assert not cfg.is_scheduled("repair_rate") and cfg.is_scheduled("stress_level")


# ------------------------------------------------------------------ simulator
def test_unscheduled_output_is_bit_identical_to_pre_schedule_golden():
    golden = np.load(FIXTURES / "simulator_golden_v0.1.0.npz")
    for seed in (1, 2):
        res = simulate(golden_config(seed))
        assert res.valid
        np.testing.assert_array_equal(res.mean_length, golden[f"mean_length_seed{seed}"])
        np.testing.assert_array_equal(res.senescent_fraction, golden[f"senescent_fraction_seed{seed}"])
        np.testing.assert_array_equal(res.final_lengths, golden[f"final_lengths_seed{seed}"])
        assert res.applied_schedule == {}


def test_single_phase_schedule_is_bit_identical_to_constant_config():
    for seed in (1, 2):
        cfg = golden_config(seed)
        one = cfg.replace(schedule={"phases": 1, "values": {
            "stress_level": [cfg.stress_level], "maintenance_rate": [cfg.maintenance_rate],
            "repair_rate": [cfg.repair_rate]}})
        a, b = simulate(cfg), simulate(one)
        np.testing.assert_array_equal(a.mean_length, b.mean_length)
        np.testing.assert_array_equal(a.final_lengths, b.final_lengths)
        np.testing.assert_array_equal(a.founder_senescence_cycle, b.founder_senescence_cycle)
        assert a.terminal_metrics == b.terminal_metrics
        assert set(b.applied_schedule) == set(GENES)
        for name in GENES:
            np.testing.assert_array_equal(b.applied_schedule[name], np.full(cfg.cycles + 1, getattr(cfg, name)))


def test_scheduled_run_records_applied_values_and_exports_json():
    cfg = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3,
                      schedule=InterventionSchedule(6, {"stress_level": alternating(0.9, 0.3)}))
    res = simulate(cfg)
    assert res.valid
    applied = res.applied_schedule["stress_level"]
    assert applied.shape == res.time.shape
    np.testing.assert_array_equal(applied, cfg.per_cycle_values("stress_level"))
    assert applied[0] == 0.9 and applied[5] == 0.3 and applied[-1] == 0.3
    payload = json.loads(json.dumps(res.to_json_dict(include_final_lengths=False), default=float))
    assert payload["applied_schedule"]["stress_level"] == applied.tolist()
    assert payload["config"]["schedule"]["phases"] == 6
    assert ModelConfig.from_dict(payload["config"]) == cfg


def test_schedule_actually_changes_dynamics_in_the_expected_direction():
    base = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3,
                       stress_level=1.0, maintenance_rate=0.0, repair_rate=0.0)
    # stress on for the whole run vs. stress on only in the first half
    half = base.replace(schedule={"phases": 2, "values": {"stress_level": [1.0, 0.0]}})
    full, relieved = simulate(base), simulate(half)
    assert relieved.mean_length[-1] > full.mean_length[-1]
    # identical up to and including the last cycle of phase 0 (same rng stream, same parameters)
    np.testing.assert_array_equal(full.mean_length[:16], relieved.mean_length[:16])
    assert not np.array_equal(full.mean_length[16:], relieved.mean_length[16:])


def test_runtime_with_schedule_stays_within_target():
    cfg = ModelConfig(schedule=InterventionSchedule(MAX_PHASES, {
        "stress_level": tuple(np.linspace(0.2, 0.8, MAX_PHASES)),
        "maintenance_rate": tuple([0.2] * MAX_PHASES),
        "repair_rate": tuple([0.2] * MAX_PHASES)}))
    res = simulate(cfg)
    assert res.valid
    assert res.runtime_seconds < 1.0


# ------------------------------------------------------------------- fitness
def test_intervention_cost_uses_time_average_and_matches_scalar_when_unscheduled():
    const = ModelConfig(cycles=60, maintenance_rate=0.6, repair_rate=0.2)
    assert intervention_cost(const) == pytest.approx(0.5 * (0.6 ** 2 + 0.2 ** 2))
    # maintenance on half the time at 0.6 -> mean 0.3
    pulsed = const.replace(schedule={"phases": 2, "values": {"maintenance_rate": [0.6, 0.0]}})
    assert pulsed.mean_value("maintenance_rate") == pytest.approx(0.3)
    assert intervention_cost(pulsed) == pytest.approx(0.5 * (0.3 ** 2 + 0.2 ** 2))
    assert intervention_cost(pulsed) < intervention_cost(const)
    # a phases=1 schedule costs exactly the same as the scalar
    one = const.replace(schedule={"phases": 1, "values": {"maintenance_rate": [0.6], "repair_rate": [0.2]}})
    assert intervention_cost(one) == intervention_cost(const)
    # and the cost flows through compute_fitness
    res = simulate(pulsed.replace(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30))
    bd = compute_fitness(res, FitnessWeights(0, 0, 0, 0, 1.0))
    assert bd.cost == pytest.approx(0.5 * (0.3 ** 2 + 0.2 ** 2))
    assert bd.total == pytest.approx(-bd.cost)


# -------------------------------------------------------------------- genome
def test_genome_expansion_and_decoding_roundtrip():
    spec = GenomeSpec(FAST, ("stress_level", "maintenance_rate", "senescence_threshold"), schedule_phases=3)
    assert spec.names == ["stress_level@0", "stress_level@1", "stress_level@2",
                          "maintenance_rate@0", "maintenance_rate@1", "maintenance_rate@2",
                          "senescence_threshold"]
    assert len(spec) == 7
    assert split_gene_name("maintenance_rate@2") == ("maintenance_rate", 2)
    assert split_gene_name("senescence_threshold") == ("senescence_threshold", None)
    for g in spec.genes:
        lo, hi = PARAMETER_BOUNDS[g.parameter][0], PARAMETER_BOUNDS[g.parameter][1]
        assert g.minimum == lo and g.maximum <= hi

    rng = np.random.default_rng(0)
    for _ in range(20):
        genome = spec.random_genome(rng)
        assert spec.from_array(spec.to_array(genome)) == pytest.approx(genome)
        cfg = spec.to_config(genome, seed=7)
        cfg.validate()
        assert cfg.seed == 7
        assert cfg.schedule is not None and cfg.schedule.phases == 3
        assert set(cfg.schedule.values) == {"stress_level", "maintenance_rate"}
        for name in ("stress_level", "maintenance_rate"):
            assert cfg.schedule.values[name] == tuple(genome[f"{name}@{k}"] for k in range(3))
            assert getattr(cfg, name) == genome[f"{name}@0"]  # scalar = phase-0 value
        assert cfg.senescence_threshold == genome["senescence_threshold"]
        assert cfg.repair_rate == FAST.repair_rate and not cfg.is_scheduled("repair_rate")

    baseline = spec.baseline_genome()
    assert all(baseline[f"stress_level@{k}"] == FAST.stress_level for k in range(3))
    assert spec.to_config(baseline).mean_value("stress_level") == FAST.stress_level


def test_genome_with_one_phase_is_the_classic_genome():
    classic = GenomeSpec(FAST, GENES)
    one = GenomeSpec(FAST, GENES, schedule_phases=1)
    assert one.names == classic.names == list(GENES)
    rng = np.random.default_rng(1)
    genome = one.random_genome(rng)
    assert one.to_config(genome).schedule is None
    assert one.to_config(genome) == classic.to_config(genome)
    with pytest.raises(ValueError):
        GenomeSpec(FAST, GENES, schedule_phases=MAX_PHASES + 1)


def test_locked_scheduled_parameter_passes_through_genome_decoding():
    base = FAST.replace(schedule={"phases": 2, "values": {"stress_level": [0.9, 0.1]}})
    # constant free genes: the locked stress schedule survives untouched
    spec1 = GenomeSpec(base, ("maintenance_rate", "repair_rate"))
    cfg1 = spec1.to_config(spec1.baseline_genome())
    assert cfg1.schedule == base.schedule
    # same phase count: merged into one schedule
    spec2 = GenomeSpec(base, ("maintenance_rate",), schedule_phases=2)
    cfg2 = spec2.to_config({"maintenance_rate@0": 0.5, "maintenance_rate@1": 0.0})
    assert cfg2.schedule.values == {"stress_level": (0.9, 0.1), "maintenance_rate": (0.5, 0.0)}
    # a free scalar gene supersedes a base schedule on the same parameter
    spec3 = GenomeSpec(base, ("stress_level",))
    assert spec3.to_config({"stress_level": 0.4}).schedule is None
    # different phase count on a locked scheduled parameter is rejected
    with pytest.raises(ValueError):
        GenomeSpec(base, ("maintenance_rate",), schedule_phases=3)


# ----------------------------------------------------------------- optimizers
def test_optimizer_configs_accept_and_validate_schedule_phases():
    assert EvolutionConfig().schedule_phases == 1
    assert MultiObjectiveConfig().schedule_phases == 1
    assert ActiveLearningConfig().schedule_phases == 1
    assert EvolutionConfig.from_dict({"schedule_phases": 4}).schedule_phases == 4
    assert EvolutionConfig.from_dict(EvolutionConfig(schedule_phases=3).to_dict()).schedule_phases == 3
    for cls in (EvolutionConfig, MultiObjectiveConfig, ActiveLearningConfig):
        with pytest.raises(ConfigError):
            cls(schedule_phases=0).validate()
        with pytest.raises(ConfigError):
            cls(schedule_phases=MAX_PHASES + 1).validate()
    # a dict from before the field existed still loads
    old = EvolutionConfig().to_dict()
    old.pop("schedule_phases")
    assert EvolutionConfig.from_dict(old).schedule_phases == 1


def test_schedule_phases_one_ga_run_matches_pre_schedule_golden():
    gold = json.loads((FIXTURES / "evolution_golden_v0.1.0.json").read_text())
    evo = EvolutionConfig(population_size=8, generations=3, seed=5, free_genes=GENES, checkpoint_every=0,
                          schedule_phases=1)
    result = EvolutionEngine(FAST, evo).run()
    assert result.best.genome == gold["best_genome"]
    assert result.best.fitness == gold["best_fitness"]
    assert [h.best_fitness for h in result.history] == gold["history_best"]
    assert result.evaluations == gold["evaluations"]
    assert result.best_config().schedule is None


def test_ga_protocol_search_smoke(tmp_path):
    evo = EvolutionConfig(population_size=8, generations=3, seed=5, free_genes=("maintenance_rate", "repair_rate"),
                          checkpoint_every=0, eval_seeds=(1,), schedule_phases=2)
    engine = EvolutionEngine(FAST.replace(stress_level=0.6), evo, run_dir=tmp_path)
    result = engine.run()
    assert set(result.best.genome) == {"maintenance_rate@0", "maintenance_rate@1", "repair_rate@0", "repair_rate@1"}
    assert result.best.fitness >= result.baseline.fitness
    best_cfg = result.best_config(seed=1)
    assert best_cfg.schedule.phases == 2
    assert best_cfg.stress_level == 0.6 and not best_cfg.is_scheduled("stress_level")
    # the recorded fitness is reproducible from the decoded config
    bd = compute_fitness(simulate(best_cfg), evo.weights)
    assert bd.total == pytest.approx(result.best.fitness)
    assert (tmp_path / "summary.csv").read_text().count("best_maintenance_rate@0") == 1
    # a second run with the same seed is identical
    again = EvolutionEngine(FAST.replace(stress_level=0.6), evo).run()
    assert again.best.genome == result.best.genome


def test_nsga2_and_active_learning_protocol_search_smoke():
    mo = MultiObjectiveConfig(population_size=8, generations=2, seed=1, free_genes=("maintenance_rate",),
                              eval_seeds=(1,), objectives=("survival", "cost"), checkpoint_every=0,
                              schedule_phases=2)
    pareto = NSGA2Engine(FAST, mo).run()
    assert pareto.front
    assert all(set(c.genome) == {"maintenance_rate@0", "maintenance_rate@1"} for c in pareto.front)

    al = ActiveLearningConfig(n_initial=4, n_iterations=2, eval_seeds=(1,), free_genes=GENES, seed=2,
                              candidate_pool_size=50, schedule_phases=2)
    result = run_active_learning(FAST, al)
    assert result.evaluations == 6
    assert set(result.best_genome) == {f"{g}@{k}" for g in GENES for k in range(2)}
    frame = result.to_frame()
    assert "gene_stress_level@1" in frame.columns


def test_sensitivity_scheduled_baseline_passes_through_and_perturbs_all_phases():
    base = FAST.replace(maintenance_rate=0.3, repair_rate=0.1,
                        schedule={"phases": 2, "values": {"maintenance_rate": [0.3, 0.0]}})
    cfg = SensitivityConfig(parameters=("maintenance_rate", "repair_rate"), perturbation_fraction=0.10,
                            eval_seeds=(1,))
    result = run_sensitivity_analysis(base, cfg)
    assert result.base_config.schedule == base.schedule
    item = {it.parameter: it for it in result.items}["maintenance_rate"]
    assert item.baseline_value == 0.3
    assert item.high_value == pytest.approx(0.4) and item.low_value == pytest.approx(0.2)
    # the perturbation is not masked by the schedule: fitness moves
    assert item.fitness_high != item.fitness_low
    # baseline fitness equals a direct evaluation of the scheduled config
    direct = compute_fitness(simulate(base.replace(seed=1)), cfg.weights)
    assert result.baseline_fitness == pytest.approx(direct.total)


# ------------------------------------------------------------------- configs
def test_shipped_protocol_configs_load_and_validate():
    root = Path(__file__).resolve().parents[1] / "configs"
    fasting = load_model_config(root / "demo_fasting.yaml")
    assert fasting.schedule is not None and fasting.schedule.phases == 6
    assert fasting.is_scheduled("stress_level")
    assert fasting.mean_value("stress_level") == pytest.approx(0.6)
    res = simulate(fasting.replace(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30))
    assert res.valid and "stress_level" in res.applied_schedule

    base, evo = load_evolution_config(root / "evolution_protocol.yaml")
    assert evo.schedule_phases == 6
    assert evo.free_genes == ("maintenance_rate", "repair_rate")
    assert base.stress_level == 0.6 and base.schedule is None
    _, locked = load_evolution_config(root / "evolution_locked.yaml")
    assert locked.schedule_phases == 1
    assert (evo.population_size, evo.generations, evo.eval_seeds, evo.seed) == \
        (locked.population_size, locked.generations, locked.eval_seeds, locked.seed)
