import pytest

from telomere_lab.analysis.sensitivity import run_sensitivity_analysis
from telomere_lab.schemas import ConfigError, ModelConfig, SensitivityConfig

FAST = ModelConfig(population_size=20, carrying_capacity=40, telomeres_per_cell=6, cycles=30, seed=3,
                   maintenance_rate=0.10, repair_rate=0.10)


def test_monotonic_parameter_shows_correct_direction_swing():
    # More repair -> less stress-induced loss -> higher fitness. Perturbing repair_rate
    # up should raise fitness and perturbing it down should lower it (holding others fixed).
    cfg = SensitivityConfig(parameters=("repair_rate",), perturbation_fraction=0.10, eval_seeds=(1, 2))
    result = run_sensitivity_analysis(FAST, cfg)
    item = result.items[0]
    assert item.parameter == "repair_rate"
    assert item.fitness_high >= item.fitness_low
    assert item.swing >= 0


def test_to_frame_shape_and_sort():
    cfg = SensitivityConfig(
        parameters=("shortening_rate", "repair_rate", "stress_level"),
        perturbation_fraction=0.10, eval_seeds=(1,),
    )
    result = run_sensitivity_analysis(FAST, cfg)
    df = result.to_frame()
    assert list(df.columns) == ["parameter", "fitness_low", "fitness_baseline", "fitness_high", "swing"]
    assert len(df) == 3
    assert set(df["parameter"]) == {"shortening_rate", "repair_rate", "stress_level"}
    swings = df["swing"].abs().tolist()
    assert swings == sorted(swings, reverse=True)


def test_deterministic_given_fixed_seeds():
    cfg = SensitivityConfig(parameters=("stress_level", "maintenance_rate"),
                            perturbation_fraction=0.10, eval_seeds=(1, 2, 3))
    a = run_sensitivity_analysis(FAST, cfg)
    b = run_sensitivity_analysis(FAST, cfg)
    assert a.to_frame().equals(b.to_frame())
    assert a.baseline_fitness == pytest.approx(b.baseline_fitness)


def test_invalid_config_rejected():
    with pytest.raises(ConfigError):
        SensitivityConfig(parameters=("noise_sd",)).validate()
    with pytest.raises(ConfigError):
        SensitivityConfig(parameters=()).validate()
    with pytest.raises(ConfigError):
        SensitivityConfig(perturbation_fraction=0.0).validate()
    with pytest.raises(ConfigError):
        SensitivityConfig(eval_seeds=()).validate()


def test_evaluations_counted():
    cfg = SensitivityConfig(parameters=("stress_level", "repair_rate"), eval_seeds=(1, 2))
    result = run_sensitivity_analysis(FAST, cfg)
    # baseline (2) + 2 parameters x (low + high) x 2 seeds = 2 + 8 = 10
    assert result.evaluations == 10
