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

Each division may also accumulate genomic instability (docs/MODEL.md §2.3):
a per-cell ``mutation_burden`` grows by ``replication_error_rate`` plus an
oxidative term scaled by ``stress_level`` and offset by ``repair_rate``; an
optional apoptosis checkpoint removes cells whose burden exceeds
``mutation_threshold`` with probability ``checkpoint_strength``. Both rate
parameters and the checkpoint default to off, so this is bit-identical to
the pre-genome-stability model when unset.

``repair_rate`` can also be made a per-cell heritable trait, population-
genetics-style (docs/MODEL.md §2.2): with ``repair_rate_mutation_sigma`` > 0,
each cell tracks its own repair_rate (seeded from its clone's starting value)
which mutates by a small Gaussian step at every division, clipped to
PARAMETER_BOUNDS, and is inherited by daughters -- mutation-selection balance
instead of a clone-shared scalar. 0.0 (default) is the feature's off switch:
repair_rate stays the plain scalar/schedule/sub-clone-override value it
always was, bit-identical to the pre-existing model.

Full derivation, rationale and limitations: ``docs/MODEL.md``.
"""

from __future__ import annotations

import time as _time
from typing import Dict, List

import numpy as np

from ..schemas import MODEL_VERSION, PARAMETER_BOUNDS, ConfigError, ModelConfig, SimulationResult, SubcloneSpec
from . import metrics as M
from .biomarker import biological_age_score
from .population import (allocate_clone_ids, divide, passage, remove_apoptotic, remove_dead, stochastic_arrest,
                         update_senescence)
from .stochastic import (division_noise, initial_lengths, initial_lengths_hierarchical, make_rng,
                         shortening_multipliers)

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
        if config.initial_within_cell_sd > 0.0:
            # Two-level founding spread (docs/MODEL.md section 2.6); unused =>
            # the single-level draw below, identical RNG stream to before.
            lengths = initial_lengths_hierarchical(
                rng, config.population_size, config.telomeres_per_cell,
                config.initial_length, config.initial_length_sd, config.initial_within_cell_sd,
            )
        else:
            lengths = initial_lengths(
                rng, config.population_size, config.telomeres_per_cell,
                config.initial_length, config.initial_length_sd,
            )
        # Per-cell heritable shortening-rate multiplier (docs/MODEL.md section 2.8).
        # Always present; drawn (and used) only when shortening_rate_cv > 0 --
        # otherwise all ones and no RNG draw is spent.
        use_shortening_cv = config.shortening_rate_cv > 0.0
        if use_shortening_cv:
            shortening_mult_cells = shortening_multipliers(rng, config.population_size, config.shortening_rate_cv)
        else:
            shortening_mult_cells = np.ones(config.population_size, dtype=float)
        use_hazard = config.senescence_softness_bp > 0.0 or config.random_arrest_rate > 0.0
        senescent = np.zeros(config.population_size, dtype=bool)
        senescent = update_senescence(lengths, senescent, config.senescence_threshold)

        # Per-founder first-passage generation of senescence onset (SDD §22
        # Level 3: comparable to the reference model's per-ancestor tracking).
        founder_id = np.arange(config.population_size)
        founder_senescence_cycle = np.full(config.population_size, -1, dtype=int)
        newly = np.flatnonzero(senescent)
        founder_senescence_cycle[founder_id[newly]] = 0

        # Genome stability (docs/MODEL.md §2.3): a per-cell mutation-burden
        # accumulator and the apoptosis-checkpoint flag derived from it. Both
        # start at zero/false; with replication_error_rate ==
        # oxidative_mutation_sensitivity == 0.0 the burden never grows, so
        # this is bit-identical to the pre-genome-stability model.
        mutation_burden = np.zeros(config.population_size, dtype=float)
        apoptotic = np.zeros(config.population_size, dtype=bool)

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

        # Genome stability (docs/MODEL.md §2.3) is also sub-clone-overridable
        # (2026-09-14, closing the composition gap docs/ROADMAP.md's
        # "Explicitly deferred" section used to list). None of these four are
        # schedulable, so -- exactly like shortening_rate_c/stress_sensitivity_c
        # above -- they are plain per-clone constant arrays, not a
        # mask/override-value pair. A default/no-subclones config makes every
        # entry equal to the scalar config value, so indexing by clone_id 0
        # reproduces the pre-existing scalar arithmetic exactly.
        replication_error_rate_c = np.array(
            [c.overrides.get("replication_error_rate", config.replication_error_rate) for c in clone_specs]
        )
        oxidative_mutation_sensitivity_c = np.array(
            [c.overrides.get("oxidative_mutation_sensitivity", config.oxidative_mutation_sensitivity)
             for c in clone_specs]
        )
        checkpoint_strength_c = np.array(
            [c.overrides.get("checkpoint_strength", config.checkpoint_strength) for c in clone_specs]
        )
        mutation_threshold_c = np.array(
            [c.overrides.get("mutation_threshold", config.mutation_threshold) for c in clone_specs]
        )

        # Per-cell heritable repair_rate (population-genetics-style mutation-
        # selection balance): each cell is seeded from its own clone's
        # starting repair_rate lookup (sub-clone overrides become the initial
        # condition, not a permanently-clamped value). Always present -- like
        # mutation_burden -- but only *used* (and only mutated at division)
        # when repair_rate_mutation_sigma > 0.0; otherwise the loop below
        # keeps using the clone-shared repair_lookup exactly as before.
        cycle0_repair_lookup = np.where(repair_override_mask, repair_override_vals, config.repair_rate)
        repair_rate_cells = cycle0_repair_lookup[clone_id]

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
            M.summarise_state(lengths, senescent, config.senescence_threshold, mutation_burden, apoptotic,
                               repair_rate_cells)
        ]
        snapshots: Dict[int, np.ndarray] = {0: lengths.ravel().copy()}
        clone_fraction_rows: List[np.ndarray] = [_clone_fractions(clone_id, n_clones)]
        failure = None
        # Cumulative population doublings (docs/MODEL.md section 2.4): growth from
        # division only, log2(N_after / N_before) per cycle, before any culling.
        pd_total = 0.0
        pd_rows: List[float] = [0.0]

        for cycle in range(1, config.cycles + 1):
            if lengths.shape[0] == 0:
                # Extinct culture: keep recording empty rows so arrays align.
                rows.append(M.summarise_state(lengths, senescent, config.senescence_threshold, mutation_burden,
                                               apoptotic, repair_rate_cells))
                clone_fraction_rows.append(_clone_fractions(clone_id, n_clones))
                pd_rows.append(pd_total)
                continue

            # 1. division of proliferative cells
            n_before_division = lengths.shape[0]
            (lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells, divided,
             shortening_mult_cells) = divide(
                lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells, shortening_mult_cells
            )
            pd_total += float(np.log2(lengths.shape[0] / n_before_division))
            pd_rows.append(pd_total)

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
                # Per-cell heritable repair_rate (population-genetics-style,
                # docs/MODEL.md §2.2): off by default (repair_rate_mutation_sigma
                # == 0.0), in which case this is exactly the clone-shared
                # repair_lookup broadcast as before -- byte-for-byte unchanged.
                # When opted into, each cell uses its OWN current value instead.
                if config.repair_rate_mutation_sigma > 0.0:
                    effective_repair = repair_rate_cells[divided]
                else:
                    effective_repair = repair_lookup[clones_sub]
                if use_shortening_cv:
                    base_shortening = shortening_rate_c[clones_sub] * shortening_mult_cells[divided]
                else:
                    base_shortening = shortening_rate_c[clones_sub]
                deterministic_loss = (
                    base_shortening
                    + stress_val * stress_sensitivity_c[clones_sub] * (1.0 - effective_repair)
                )
                max_gain_arr = maintenance_lookup[clones_sub] * config.maintenance_max_gain
                loss = deterministic_loss[:, None] + division_noise(rng, sub.shape, config.noise_sd)
                gain = max_gain_arr[:, None] * maintenance_weights(sub, saturation_length, config.initial_length)
                lengths[divided] = np.maximum(sub - loss + gain, 0.0)

                # 3.5. genome stability (docs/MODEL.md §2.3): baseline
                # replication error plus an oxidative contribution offset by
                # repair_rate, reusing the same effective repair value as
                # above. Zero when both rate parameters are at their default,
                # so mutation_burden never leaves zero. Per-clone lookup
                # (docs/MODEL.md §2.2 composition), indexed exactly like
                # shortening_rate_c/stress_sensitivity_c above.
                mutation_burden[divided] += (
                    replication_error_rate_c[clones_sub]
                    + stress_val * oxidative_mutation_sensitivity_c[clones_sub] * (1.0 - effective_repair)
                )

                # 3.6. per-cell repair_rate mutation step (population-genetics
                # -style heritable drift): a small Gaussian step per dividing
                # row (parent-copy and daughter alike), clipped to
                # PARAMETER_BOUNDS["repair_rate"]. No RNG draw at all when the
                # feature is off, so the default path's RNG stream (and the
                # golden bit-identity fixture) is untouched.
                if config.repair_rate_mutation_sigma > 0.0:
                    lo, hi = PARAMETER_BOUNDS["repair_rate"][0], PARAMETER_BOUNDS["repair_rate"][1]
                    step = division_noise(rng, (int(divided.sum()),), config.repair_rate_mutation_sigma)
                    repair_rate_cells[divided] = np.clip(repair_rate_cells[divided] + step, lo, hi)

            if not np.all(np.isfinite(lengths)):
                failure = f"non-finite telomere length at cycle {cycle}"
                break

            # 4. senescence check on shortest telomere
            was_senescent = senescent
            if use_hazard:
                # Optional stochastic arrest (docs/MODEL.md section 2.7).
                senescent = stochastic_arrest(rng, lengths, senescent, config.senescence_threshold,
                                              config.senescence_softness_bp, config.random_arrest_rate)
            else:
                senescent = update_senescence(lengths, senescent, config.senescence_threshold)
            newly = np.flatnonzero(senescent & ~was_senescent)
            if newly.size:
                fids = founder_id[newly]
                unset = founder_senescence_cycle[fids] < 0
                founder_senescence_cycle[fids[unset]] = cycle

            # 4.5. apoptosis checkpoint (docs/MODEL.md §2.3): cells over the
            # mutation threshold may be removed before senescent-death, so
            # they aren't double-counted this cycle. Computed unconditionally
            # (cheap); only checkpoint_strength gates actual removal. Both
            # thresholds are per-clone lookups (docs/MODEL.md §2.2
            # composition) indexed by the FULL clone_id -- unlike
            # replication_error_rate/oxidative_mutation_sensitivity above,
            # these two apply to every living cell each cycle, not only
            # cells that just divided.
            apoptotic = mutation_burden > mutation_threshold_c[clone_id]
            (lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells, apoptotic,
             shortening_mult_cells) = remove_apoptotic(
                rng, lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells, apoptotic,
                checkpoint_strength_c[clone_id], shortening_mult_cells
            )

            # 5. loss of senescent cells
            (lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells,
             shortening_mult_cells) = remove_dead(
                rng, lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells,
                config.senescent_death_rate, shortening_mult_cells
            )

            # 6. passaging back to capacity
            (lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells,
             shortening_mult_cells) = passage(
                rng, lengths, senescent, founder_id, clone_id, mutation_burden, repair_rate_cells,
                config.carrying_capacity, shortening_mult_cells
            )

            # 7. bookkeeping
            rows.append(M.summarise_state(lengths, senescent, config.senescence_threshold, mutation_burden, apoptotic,
                                           repair_rate_cells))
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
        return _assemble(config, rows, snapshots, lengths, mutation_burden, repair_rate_cells, founder_senescence_cycle,
                         applied_schedule, clone_fraction, t0, clone_id=clone_id, mutation_threshold_c=mutation_threshold_c,
                         population_doublings=np.asarray(pd_rows, dtype=float))


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


def _assemble(config, rows, snapshots, lengths, mutation_burden, repair_rate_cells, founder_senescence_cycle,
              applied_schedule, clone_fraction, t0, clone_id, mutation_threshold_c,
              population_doublings) -> SimulationResult:
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
        mean_mutation_burden=_stack(rows, "mean_mutation_burden"),
        apoptotic_fraction=_stack(rows, "apoptotic_fraction"),
        mean_repair_rate=_stack(rows, "mean_repair_rate"),
        population_doublings=population_doublings,
        time_hours=(time * config.hours_per_cycle if config.hours_per_cycle > 0.0
                    else np.full(time.shape, np.nan)),
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
    # Genome stability terminal metrics (docs/MODEL.md §2.3): survivors-only
    # snapshot at the final cycle, consistent with final_senescent_fraction /
    # fraction_below_threshold's own semantics -- not a cumulative count.
    final_burden = mutation_burden
    result.terminal_metrics["final_mutation_burden"] = (
        float(final_burden.mean()) if final_burden.size else 0.0
    )
    # Per-clone threshold lookup (docs/MODEL.md §2.2 composition) -- a
    # default/no-subclones config makes every entry config.mutation_threshold,
    # so this is unchanged from the plain scalar comparison it replaces.
    final_threshold = mutation_threshold_c[clone_id] if final_burden.size else final_burden
    result.terminal_metrics["genomic_instability_index"] = (
        float((final_burden > final_threshold).mean()) if final_burden.size else 0.0
    )
    # Per-cell heritable repair_rate terminal metrics: mean reflects the
    # nominal/seed value when repair_rate_mutation_sigma == 0.0 (the feature's
    # off switch); std > 0 shows the population diversified once opted in.
    result.terminal_metrics["final_repair_rate_mean"] = (
        float(repair_rate_cells.mean()) if repair_rate_cells.size else 0.0
    )
    result.terminal_metrics["final_repair_rate_std"] = (
        float(repair_rate_cells.std()) if repair_rate_cells.size else 0.0
    )
    # Cumulative population doublings and (optional) wall-clock mapping
    # (docs/MODEL.md sections 2.4-2.5): deterministic, no RNG.
    result.terminal_metrics["total_pd"] = float(population_doublings[-1])
    if config.hours_per_cycle > 0.0:
        result.terminal_metrics["total_days"] = float(time[-1] * config.hours_per_cycle / 24.0)
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
        mean_mutation_burden=nan, apoptotic_fraction=nan, mean_repair_rate=nan,
        population_doublings=nan, time_hours=nan,
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
