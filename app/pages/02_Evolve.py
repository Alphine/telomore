"""Page 2 - Evolve: run the evolutionary optimizer (SDD §16)."""

import pandas as pd
import streamlit as st

import ui  # noqa: F401
from ui import charts
from ui.components import (
    baseline_config, disclaimer, evolution_defaults, page_setup, set_state, weights,
)
from ui.controls import evolution_controls, fitness_weight_controls

from telomere_lab.evolution.engine import GenerationRecord
from telomere_lab.experiments.artifacts import evolution_json
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import run_evolution

page_setup("Evolve", "🧬")
disclaimer()

base = baseline_config()
st.caption(
    f"Baseline (fixed genes come from here): stress {base.stress_level:.2f} · maintenance "
    f"{base.maintenance_rate:.2f} · repair {base.repair_rate:.2f} · shortening {base.shortening_rate:.0f} bp · "
    f"threshold {base.senescence_threshold/1000:.1f} kb · {base.cycles} cycles · seed {base.seed}. "
    "Change it on the Simulate page with *Set as baseline*."
)

with st.form("evolve_form"):
    st.markdown("#### Objective (fitness weights)")
    w = fitness_weight_controls(weights())
    st.markdown("#### Optimizer")
    evo = evolution_controls(evolution_defaults())
    evo.weights = w
    notes = st.text_input("Notes for the experiment ledger", "")
    submitted = st.form_submit_button("🧬 Evolve", type="primary", width="stretch")

if st.session_state.get("evo_running"):
    if st.button("⏹ Stop", type="secondary"):
        st.session_state["evo_running"] = False
        st.rerun()

if submitted:
    try:
        evo.validate()
    except Exception as exc:  # noqa: BLE001
        st.error(f"Invalid optimizer configuration: {exc}")
        st.stop()
    set_state("fitness_weights", w)
    set_state("evolution_config", evo)
    st.session_state["evo_running"] = True
    st.session_state["evo_live_history"] = []

    n_total = evo.generations
    progress = st.progress(0.0, text="Initialising population…")
    live_chart = st.empty()
    live_text = st.empty()

    def on_generation(rec: GenerationRecord) -> None:
        hist = st.session_state["evo_live_history"]
        hist.append(rec.to_dict())
        progress.progress(min(rec.generation / n_total, 1.0),
                          text=f"Generation {rec.generation}/{n_total} · best {rec.best_fitness:+.4f} · "
                               f"{rec.evaluations_so_far} simulations · {rec.elapsed_seconds:.0f}s")
        df = pd.DataFrame(hist)
        live_chart.plotly_chart(charts.evolution_fitness_chart(df), width="stretch")
        live_text.caption("Best genome so far: " + ", ".join(f"{k}={v:.3f}" for k, v in rec.best_genome.items()))

    def should_stop() -> bool:
        return not st.session_state.get("evo_running", False)

    with st.spinner("Evolving…"):
        result, record = run_evolution(base, evo, ExperimentRegistry(), callback=on_generation,
                                       should_stop=should_stop, notes=notes)
    st.session_state["evo_running"] = False
    set_state("evo_result", result)
    set_state("evo_record", record)
    progress.empty(); live_chart.empty(); live_text.empty()
    st.rerun()

result = st.session_state.get("evo_result")
record = st.session_state.get("evo_record")
if result is None:
    st.markdown("Configure the objective and optimizer, then press **Evolve**. "
                "A 32 × 20 run takes on the order of a minute or two on a laptop CPU.")
    st.stop()

# ---------------------------------------------------------------- results
imp = result.best.fitness - result.baseline.fitness
c = st.columns(5)
c[0].metric("Baseline fitness", f"{result.baseline.fitness:+.3f}")
c[1].metric("Best fitness", f"{result.best.fitness:+.3f}", delta=f"{imp:+.3f}")
c[2].metric("Generations", f"{len(result.history) - 1}")
c[3].metric("Simulations run", f"{result.evaluations}")
c[4].metric("Runtime", f"{result.runtime_seconds:.0f} s")
if result.stopped_early:
    st.warning(f"Stopped early: {result.stop_reason}")
if record:
    st.success(f"Recorded as **{record['run_id']}** · config hash `{record['configuration_hash']}` · "
               f"git `{record['git_commit'] or 'n/a'}`")

hist = result.history_frame()
c1, c2 = st.columns(2)
c1.plotly_chart(charts.evolution_fitness_chart(hist), width="stretch")
c2.plotly_chart(charts.diversity_chart(hist), width="stretch")
st.plotly_chart(charts.parameter_trajectory_chart(hist, list(result.evolution_config.free_genes)),
                width="stretch")

st.markdown("#### Best candidate vs baseline (free genes)")
rows = []
for g in result.evolution_config.free_genes:
    b, e = result.baseline.genome[g], result.best.genome[g]
    rows.append({"gene": g, "baseline": b, "evolved": e, "change": e - b,
                 "change %": (e - b) / b * 100 if b else float("nan")})
st.dataframe(pd.DataFrame(rows).style.format({"baseline": "{:.3f}", "evolved": "{:.3f}",
                                              "change": "{:+.3f}", "change %": "{:+.1f}"}),
             hide_index=True, width="stretch")

st.markdown("#### Final population")
pop = result.population_frame()
st.dataframe(pop.style.format(precision=3), hide_index=True, width="stretch", height=300)

st.markdown("#### Export")
c1, c2 = st.columns(2)
c1.download_button("⬇ Evolution result (JSON)", evolution_json(result),
                   f"{record['run_id'] if record else 'evolution'}.json", "application/json", width="stretch")
c2.download_button("⬇ Generation history (CSV)", hist.to_csv(index=False),
                   f"{record['run_id'] if record else 'evolution'}_history.csv", "text/csv", width="stretch")
st.caption("Fitness ≠ biological truth. The optimizer optimised the objective above under the "
           "model's assumptions; see docs/SCIENTIFIC_SCOPE.md.")
