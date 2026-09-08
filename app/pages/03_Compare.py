"""Page 3 - Compare: baseline vs best evolved vs user-selected (SDD §16)."""

import pandas as pd
import streamlit as st

import ui  # noqa: F401
from ui import charts
from ui.components import baseline_config, disclaimer, page_setup, weights
from ui.controls import model_controls

from telomere_lab.evolution.genome import GenomeSpec
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import compare_scenarios, deltas
from telomere_lab.schemas import EvolutionConfig, ModelConfig

page_setup("Compare", "⚖️")
disclaimer()

base: ModelConfig = baseline_config()
evo_result = st.session_state.get("evo_result")

scenarios = {"Baseline": base}
spec = None          # GenomeSpec of the evolved run, if any
population = None    # DataFrame of the evolved run's final population, if any

if evo_result is not None:
    spec = GenomeSpec(evo_result.base_config, evo_result.evolution_config.free_genes)
    scenarios["Best evolved"] = spec.to_config(evo_result.best.genome, seed=base.seed)
    population = evo_result.population_frame()
    st.caption("'Best evolved' comes from the Evolve run in this session.")
else:
    # Fall back to the experiment ledger so the page works after a reload / from the CLI.
    registry = ExperimentRegistry()
    evo_runs = [r for r in registry.list_runs() if r["kind"] == "evolution"]
    if evo_runs:
        run_ids = [r["run_id"] for r in sorted(evo_runs, key=lambda r: r["created_at"], reverse=True)]
        chosen = st.selectbox("No Evolve result in this session — load 'Best evolved' from the ledger:",
                              run_ids)
        rec = registry.load(chosen)
        run_base = ModelConfig.from_dict(rec["configuration"]["model"])
        run_evo = EvolutionConfig.from_dict(rec["configuration"]["evolution"])
        spec = GenomeSpec(run_base, run_evo.free_genes)
        scenarios["Best evolved"] = spec.to_config(rec["best_genome"], seed=base.seed)
        pop_csv = registry.run_dir(chosen) / "final_population.csv"
        if pop_csv.exists():
            population = pd.read_csv(pop_csv)
        st.caption(f"'Best evolved' loaded from ledger run **{chosen}** "
                   f"(fitness {rec['fitness']:+.4f}, seed {rec['seed']}). Its fixed genes come from that "
                   "run's configuration; the baseline is this session's baseline.")
    else:
        st.warning("No evolution result in this session or in the ledger yet — run the **Evolve** page "
                   "to add the 'Best evolved' scenario. You can still compare the baseline with a "
                   "manual scenario.")

with st.sidebar:
    st.header("Third scenario")
    options = ["None", "Pick from evolved population", "Manual parameters"]
    if st.session_state.get("compare_user_config") is not None:
        options.insert(1, "From Pareto page")
    mode = st.radio("Source", options, index=1 if len(options) > 3 or population is not None else 0)
    third = None
    if mode == "From Pareto page":
        third = st.session_state["compare_user_config"]
        st.caption(", ".join(f"{k}={getattr(third, k):.3f}"
                             for k in ("stress_level", "maintenance_rate", "repair_rate")))
    elif mode == "Pick from evolved population" and population is not None and spec is not None:
        rank = st.number_input("Rank in final population", 1, len(population), min(2, len(population)))
        row = population.iloc[int(rank) - 1]
        genome = {g: float(row[g]) for g in spec.names}
        third = spec.to_config(genome, seed=base.seed)
        st.caption(", ".join(f"{k}={v:.3f}" for k, v in genome.items()))
    elif mode == "Pick from evolved population":
        st.caption("No evolved population available.")
    elif mode == "Manual parameters":
        third = model_controls(base, key_prefix="cmp", advanced=False)
    if third is not None:
        scenarios["User-selected"] = third
    same_seed = st.checkbox("Force identical simulator seed across scenarios", value=True,
                            help="Common random numbers make differences attributable to parameters.")

if same_seed:
    scenarios = {k: v.replace(seed=base.seed) for k, v in scenarios.items()}

with st.spinner("Simulating scenarios…"):
    comps = compare_scenarios(scenarios, weights())

invalid = [c.name for c in comps if not c.result.valid]
if invalid:
    st.error(f"Invalid scenario(s): {', '.join(invalid)}")
    comps = [c for c in comps if c.result.valid]
if not comps:
    st.stop()

results = {c.name: c.result for c in comps}
st.plotly_chart(charts.comparison_grid(results), width="stretch", key="cmp_grid")

c1, c2 = st.columns(2)
c1.plotly_chart(charts.overlay(results, "mean_length", "Mean telomere length (kb)", "kb", kb=True,
                               hline=base.senescence_threshold / 1000), width="stretch", key="cmp_len")
c2.plotly_chart(charts.overlay(results, "population_size", "Living cells", "cells"), width="stretch",
                key="cmp_pop")

st.markdown("#### Deltas relative to baseline (model outputs)")
baseline = comps[0]
rows = []
for c in comps[1:]:
    d = deltas(baseline, c)
    rows.append({
        "scenario": c.name,
        "fitness": c.breakdown.total,
        "Δ fitness": d["fitness_abs"],
        "Δ fitness %": d["fitness_pct"],
        "Δ senescence (pp)": d["senescence_pp"],
        "Δ shortest-telomere reserve (kb)": d["reserve_kb"],
        "Δ mean length (kb)": d["mean_length_kb"],
        "Δ survival (AUC)": d["survival_abs"],
    })
if rows:
    st.dataframe(pd.DataFrame(rows).style.format(precision=3), hide_index=True, width="stretch")
else:
    st.caption("Add a second scenario to see deltas.")

st.markdown("#### Scenario parameters")
param_rows = []
for c in comps:
    r = {"scenario": c.name, "fitness": round(c.breakdown.total, 4)}
    r.update({k: v for k, v in c.config.to_dict().items()
              if k in ("stress_level", "maintenance_rate", "repair_rate", "shortening_rate",
                       "initial_length", "senescence_threshold", "seed")})
    param_rows.append(r)
st.dataframe(pd.DataFrame(param_rows), hide_index=True, width="stretch")

st.markdown("#### Fitness composition")
cols = st.columns(len(comps))
for i, (col, c) in enumerate(zip(cols, comps)):
    fig = charts.fitness_breakdown_bar({**c.breakdown.to_dict(), "total": c.breakdown.total},
                                       weights().to_dict())
    fig.update_layout(title_text=f"{c.name}: weighted contributions (total {c.breakdown.total:+.3f})")
    # explicit keys: two scenarios can have identical figures (e.g. duplicate elites)
    col.plotly_chart(fig, width="stretch", key=f"fitness_breakdown_{i}")
st.caption("All values are outputs of the simulation model under the current objective weights. "
           "They are not predictions about any organism or patient.")
