"""The lightweight telomere population model (SDD §9).

Per cell cycle, for every cell that divides, each telomere changes by

    L_next = L
             - replication_loss                      (shortening_rate + noise)
             - stress_level * stress_sensitivity * (1 - repair_rate)
             + maintenance_rate * maintenance_max_gain * w(L)

where ``w(L)`` in [0, 1] preferentially directs maintenance to the *shortest*
telomere of the cell and saturates as telomeres approach twice the initial
length. A cell enters irreversible senescence when its shortest telomere
falls below ``senescence_threshold``. Senescent cells no longer divide and
are lost at ``senescent_death_rate`` per cycle. The culture is passaged
(randomly diluted) back to ``carrying_capacity`` whenever it overgrows.

``stress_level``, ``maintenance_rate`` and ``repair_rate`` may optionally be
piecewise constant in time (``ModelConfig.schedule``, docs/MODEL.md §2.1);
the loop reads the value scheduled for each division step and records what
it applied in ``SimulationResult.applied_schedule``. An unscheduled config
runs the identical arithmetic as before schedules existed.

Full derivation, rationale and limitations: ``docs/MODEL.md``.
"""

from __future__ import annotations

import time as _time
from typing import Dict, List

import numpy as np

from ..schemas import MODEL_VERSION, ConfigError, ModelConfig, SimulationResult, SubcloneSpec
from . import metrics as M
from .biomarker import biological_age_score
from .population import allocate_clone_ids, divide, passage, remove_dead, update_senescence
from .stochastic import division_noise, initial_lengths, make_rng

#: Single implicit clone used when ``config.subclones`` is unset -- an empty
#: overrides dict means every per-cell lookup falls back to the config's own
#: scalar/schedule values, which is exactly what makes the unset case
#: bit-identical to the pre-subclone model.
_DEFAULT_CLONE = (SubcloneSpec(name="default", initial_fraction=1.0, overrides={}),)

#: Length scale (bp) of the preference for short telomeres in maintenance.
MAINTENANCE_PREFERENCE_TAU = 1000.0
#: Maintenance saturates as telomeres approach this multiple of initial length.
MAINTENANCE_SATURATION_FACTOR = 2.0


def maintenance_weights(lengths: np.ndarray, saturation_length: float,
                        reference_length: float) -> np.ndarray:
    """Relative maintenance directed at each telomere of each cell.

    * ``exp(-(L - L_min_cell) / tau)`` -> the shortest telomere in a cell gets
      weight 1, longer ones exponentially less (telomerase preferentially acts
      on short telomeres).
    * ``clip((L_sat - L) / (L_sat - L_ref), 0, 1)`` -> full gain up to the
      reference (initial) length, then a linear ramp down to zero at the
      saturation length, preventing unbounded growth.
    """
    if lengths.size == 0:
        return lengths
    per_cell_min = lengths.min(axis=1, keepdims=True)
    preference = np.exp(-(lengths - per_cell_min) / MAINTENANCE_PREFERENCE_TAU)
    ramp = max(saturation_length - reference_length, 1.0)
    saturation = np.clip((saturation_length - lengths) / ramp, 0.0, 1.0)
    return preference * saturation


class SimpleTelomereModel:
    """Reference MVP implementation of the ``TelomereModelAdapter`` protocol."""

    name = "simple-telomere-model"
    version = MODEL_VERSION

    def simulate(self, config: ModelConfig) -> SimulationResult:
        t0 = _time.perf_counter()
        try:
            config.validate()
        except ConfigError as exc:
            return _failed_result(config, f"invalid configuration: {exc}", t0)

        rng = make_rng(config.seed)
        lengths = initial_lengths(
            rng, config.population_size, config.telomeres_per_cell,
            config.initial_length, config.initial_length_sd,
        )
        senescent = np.zeros(config.population_size, dtype=bool)
        senescent = update_senescence(lengths, senescent, config.senescence_threshold)

        # Per-founder first-passage generation of senescence onset (SDD §22
        # Level 3: comparable to the reference model's per-ancestor tracking).
        founder_id = np.arange(config.population_size)
        founder_senescence_cycle = np.full(config.population_size, -1, dtype=int)
        newly = np.flatnonzero(senescent)
        founder_senescence_cycle[founder_id[newly]] = 0

        # Sub-clone competition (docs/MODEL.md §2.2): deterministic
        # largest-remainder allocation of the founding cells across clones, or
        # the single implicit "default" clone (no overrides) when unset -- the
        # allocation spends no RNG draw, so an unset config's RNG stream is
        # untouched.
        clone_specs = config.subclones if config.subclones is not None else _DEFAULT_CLONE
        clone_names = [c.name for c in clone_specs]
        n_clones = len(clone_specs)
        if config.subclones is not None:
            clone_id = allocate_clone_ids(config.population_size, [c.initial_fraction for c in clone_specs])
        else:
            clone_id = np.zeros(config.population_size, dtype=int)

        # Per-clone lookup tables for the per-cell-arithmetic parameters a
        # clone may override, built once (not per cycle -- these are static
        # genetic constants). shortening_rate / stress_sensitivity are never
        # schedulable, so a clone's override on them simply replaces the
        # config's scalar for that clone's cells. maintenance_rate /
        # repair_rate CAN be scheduled: an override on those means "this
        # clone's own constant value, ignoring the shared schedule for this
        # parameter"; a clone without that override uses the shared
        # schedule/scalar value like every clone did before subclones existed.
        shortening_rate_c = np.array(
            [c.overrides.get("shortening_rate", config.shortening_rate) for c in clone_specs]
        )
        stress_sensitivity_c = np.array(
            [c.overrides.get("stress_sensitivity", config.stress_sensitivity) for c in clone_specs]
        )
        maintenance_override_mask = np.array(["maintenance_rate" in c.overrides for c in clone_specs])
        maintenance_override_vals = np.array([c.overrides.get("maintenance_rate", 0.0) for c in clone_specs])
        repair_override_mask = np.array(["repair_rate" in c.overrides for c in clone_specs])
        repair_override_vals = np.array([c.overrides.get("repair_rate", 0.0) for c in clone_specs])

        # Scheduled parameters (docs/MODEL.md §2.1): one value per division
        # step, precomputed once so the loop only indexes an array. Entry
        # ``t`` is the value in force during the step t -> t+1. Unscheduled
        # parameters are constant arrays holding the scalar field, so the
        # arithmetic below is identical to the constant-parameter model.
        stress_t = config.per_cycle_values("stress_level")
        maintenance_t = config.per_cycle_values("maintenance_rate")
        repair_t = config.per_cycle_values("repair_rate")
        applied_schedule = {
            name: arr for name, arr in (("stress_level", stress_t), ("maintenance_rate", maintenance_t),
                                        ("repair_rate", repair_t)) if config.is_scheduled(name)
        }
        saturation_length = MAINTENANCE_SATURATION_FACTOR * config.initial_length

        rows: List[Dict[str, float]] = [
            M.summarise_state(lengths, senescent, config.senescence_threshold)
        ]
        snapshots: Dict[int, np.ndarray] = {0: lengths.ravel().copy()}
        clone_fraction_rows: List[np.ndarray] = [_clone_fractions(clone_id, n_clones)]
        failure = None

        for cycle in range(1, config.cycles + 1):
            if lengths.shape[0] == 0:
                # Extinct culture: keep recording empty rows so arrays align.
                rows.append(M.summarise_state(lengths, senescent, config.senescence_threshold))
                clone_fraction_rows.append(_clone_fractions(clone_id, n_clones))
                continue

            # 1. division of proliferative cells
            lengths, senescent, founder_id, clone_id, divided = divide(lengths, senescent, founder_id, clone_id)

            # 2-3. shortening + maintenance on every replicated copy, with the
            # parameter values scheduled for this step (index cycle - 1) and,
            # when subclones are set, each cell's own clone-specific values
            # (docs/MODEL.md §2.2) -- a small per-clone lookup indexed by
            # clone_id, not a per-cycle Python branch, so this reduces to the
            # exact original scalar arithmetic when there is one clone.
            step = cycle - 1
            stress_val = float(stress_t[step])
            shared_maintenance = float(maintenance_t[step])
            shared_repair = float(repair_t[step])
            maintenance_lookup = np.where(maintenance_override_mask, maintenance_override_vals, shared_maintenance)
            repair_lookup = np.where(repair_override_mask, repair_override_vals, shared_repair)
            if divided.any():
                sub = lengths[divided]
                clones_sub = clone_id[divided]
                deterministic_loss = (
                    shortening_rate_c[clones_sub]
                    + stress_val * stress_sensitivity_c[clones_sub] * (1.0 - repair_lookup[clones_sub])
                )
                max_gain_arr = maintenance_lookup[clones_sub] * config.maintenance_max_gain
                loss = deterministic_loss[:, None] + division_noise(rng, sub.shape, config.noise_sd)
                gain = max_gain_arr[:, None] * maintenance_weights(sub, saturation_length, config.initial_length)
                lengths[divided] = np.maximum(sub - loss + gain, 0.0)

            if not np.all(np.isfinite(lengths)):
                failure = f"non-finite telomere length at cycle {cycle}"
                break

            # 4. senescence check on shortest telomere
            was_senescent = senescent
            senescent = update_senescence(lengths, senescent, config.senescence_threshold)
            newly = np.flatnonzero(senescent & ~was_senescent)
            if newly.size:
                fids = founder_id[newly]
                unset = founder_senescence_cycle[fids] < 0
                founder_senescence_cycle[fids[unset]] = cycle

            # 5. loss of senescent cells
            lengths, senescent, founder_id, clone_id = remove_dead(
                rng, lengths, senescent, founder_id, clone_id, config.senescent_death_rate
            )

            # 6. passaging back to capacity
            lengths, senescent, founder_id, clone_id = passage(
                rng, lengths, senescent, founder_id, clone_id, config.carrying_capacity
            )

            # 7. bookkeeping
            rows.append(M.summarise_state(lengths, senescent, config.senescence_threshold))
            clone_fraction_rows.append(_clone_fractions(clone_id, n_clones))
            every = config.record_distribution_every
            if every > 0 and cycle % every == 0:
                snapshots[cycle] = lengths.ravel().copy()

        if failure is not None:
            return _failed_result(config, failure, t0)

        snapshots[config.cycles] = lengths.ravel().copy()
        clone_fraction = (
            {name: np.stack(clone_fraction_rows, axis=0)[:, i] for i, name in enumerate(clone_names)}
            if config.subclones is not None else {}
        )
        return _assemble(config, rows, snapshots, lengths, founder_senescence_cycle, applied_schedule,
                         clone_fraction, t0)


def _stack(rows: List[Dict[str, float]], key: str, dtype=float) -> np.ndarray:
    return np.asarray([r[key] for r in rows], dtype=dtype)


def _clone_fractions(clone_id: np.ndarray, n_clones: int) -> np.ndarray:
    """Fraction of the living population in each clone, length ``n_clones``.

    All zeros (not NaN) for an extinct/empty population -- ``clone_fraction``
    handles that gracefully rather than dividing by zero.
    """
    n = clone_id.shape[0]
    if n == 0:
        return np.zeros(n_clones, dtype=float)
    counts = np.bincount(clone_id, minlength=n_clones)[:n_clones]
    return counts / n


def _assemble(config, rows, snapshots, lengths, founder_senescence_cycle, applied_schedule, clone_fraction, t0
              ) -> SimulationResult:
    time = np.arange(len(rows), dtype=float)
    result = SimulationResult(
        seed=config.seed,
        config=config,
        model_version=MODEL_VERSION,
        time=time,
        mean_length=_stack(rows, "mean_length"),
        median_length=_stack(rows, "median_length"),
        shortest_length=_stack(rows, "shortest_length"),
        p10_length=_stack(rows, "p10_length"),
        mean_shortest_per_cell=_stack(rows, "mean_shortest_per_cell"),
        senescent_fraction=_stack(rows, "senescent_fraction"),
        population_size=_stack(rows, "population_size", dtype=int),
        proliferative_count=_stack(rows, "proliferative_count", dtype=int),
        fraction_below_threshold=_stack(rows, "fraction_below_threshold"),
        length_cv=_stack(rows, "length_cv"),
        final_lengths=lengths.ravel().copy(),
        distribution_snapshots=snapshots,
        founder_senescence_cycle=founder_senescence_cycle.copy(),
        applied_schedule={k: np.asarray(v, dtype=float).copy() for k, v in applied_schedule.items()},
        clone_fraction={k: np.asarray(v, dtype=float).copy() for k, v in clone_fraction.items()},
    )
    result.terminal_metrics = M.terminal_metrics(
        time=result.time,
        mean_length=result.mean_length,
        mean_shortest_per_cell=result.mean_shortest_per_cell,
        senescent_fraction=result.senescent_fraction,
        population_size=result.population_size,
        proliferative_count=result.proliferative_count,
        length_cv=result.length_cv,
        carrying_capacity=config.carrying_capacity,
        initial_length=config.initial_length,
        threshold=config.senescence_threshold,
    )
    result.runtime_seconds = _time.perf_counter() - t0
    # Synthetic "biological age" biomarker (ROADMAP.md candidate feature #5):
    # a pure, post-hoc derived-metric pass over the already-completed result,
    # not a new simulation mechanism -- see simulator/biomarker.py.
    result.biological_age = biological_age_score(result)
    return result


def _failed_result(config: ModelConfig, reason: str, t0: float) -> SimulationResult:
    """Explicit failure object (SDD §30) - never silently a good result."""
    n = int(getattr(config, "cycles", 1)) + 1
    nan = np.full(n, np.nan)
    zeros = np.zeros(n, dtype=int)
    result = SimulationResult(
        seed=int(getattr(config, "seed", -1)),
        config=config,
        model_version=MODEL_VERSION,
        time=np.arange(n, dtype=float),
        mean_length=nan, median_length=nan, shortest_length=nan, p10_length=nan,
        mean_shortest_per_cell=nan, senescent_fraction=nan,
        population_size=zeros, proliferative_count=zeros,
        fraction_below_threshold=nan, length_cv=nan,
        final_lengths=np.array([]),
        terminal_metrics={},
        valid=False,
        failure_reason=reason,
        runtime_seconds=_time.perf_counter() - t0,
    )
    result.biological_age = biological_age_score(result)  # explicit empty/invalid, never a crash
    return result


_DEFAULT_MODEL = SimpleTelomereModel()


def simulate(config: ModelConfig, seed: int | None = None) -> SimulationResult:
    """Convenience wrapper: run the default model, optionally overriding the seed."""
    if seed is not None:
        config = config.replace(seed=seed)
    return _DEFAULT_MODEL.simulate(config)
