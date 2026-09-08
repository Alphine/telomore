"""Page 5 - Pareto: NSGA-II multi-objective search. Shows the trade-off surface
instead of a single weighted winner."""

import json

import pandas as pd
import streamlit as st

import ui  # noqa: F401
from ui import charts
from ui.components import baseline_config, disclaimer, page_setup, set_state, weights

from telomere_lab.evolution.genome import GenomeSpec
from telomere_lab.experiments.registry import ExperimentRegistry, _json_default
from telomere_lab.experiments.runner import run_pareto
from telomere_lab.schemas import EVOLVABLE_PARAMETERS, OBJECTIVES, MultiObjectiveConfig

page_setup("Pareto", "🎯")
disclaimer()

base = baseline_config()
st.markdown(
    "**Why a second optimizer?** The GA on the Evolve page needs weights to collapse five outcomes into "
    "one number, and the winner moves when the weights move. **NSGA-II** keeps every candidate that is "
    "not beaten on *all* objectives at once — the **Pareto front** — so the trade-off itself becomes the "
    "result. Pick the point that matches your experimental priorities afterwards."
)
st.caption(
    f"Baseline: stress {base.stress_level:.2f} · maintenance {base.maintenance_rate:.2f} · repair "
    f"{base.repair_rate:.2f} · {base.cycles} cycles · seed {base.seed}. Change it on the Simulate page."
)

defaults = st.session_state.get("mo_config") or MultiObjectiveConfig(weights=weights())

with st.form("pareto_form"):
    st.markdown("#### Objectives")
    objs = st.multiselect("Optimise simultaneously (first two are plotted)", list(OBJECTIVES),
                          list(defaults.objectives),
                          format_func=lambda o: f"{o} ({OBJECTIVES[o][0]}) — {OBJECTIVES[o][1]}")
    st.markdown("#### Optimizer")
    c1, c2, c3 = st.columns(3)
    pop = c1.number_input("Population (even)", 8, 200, int(defaults.population_size), step=2)
    gens = c2.number_input("Generations", 1, 200, int(defaults.generations))
    seed = c3.number_input("Optimizer seed", 0, 2**31 - 1, int(defaults.seed))
    c4, c5, c6 = st.columns(3)
    mrate = c4.slider("Mutation rate", 0.0, 1.0, float(defaults.mutation_rate), 0.05)
    msigma = c5.slider("Mutation sigma", 0.01, 0.5, float(defaults.mutation_sigma), 0.01)
    xrate = c6.slider("Crossover rate", 0.0, 1.0, float(defaults.crossover_rate), 0.05)
    free = st.multiselect("Genes the optimizer may change", list(EVOLVABLE_PARAMETERS), list(defaults.free_genes))
    notes = st.text_input("Notes for the ledger", "")
    submitted = st.form_submit_button("🎯 Run NSGA-II", type="primary", width="stretch")

if submitted:
    try:
        mo = MultiObjectiveConfig(
            population_size=int(pop), generations=int(gens), mutation_rate=float(mrate),
            mutation_sigma=float(msigma), crossover_rate=float(xrate), seed=int(seed),
            free_genes=tuple(free) or defaults.free_genes, objectives=tuple(objs) or defaults.objectives,
            weights=weights(),
        ).validate()
    except Exception as exc:  # noqa: BLE001
        st.error(f"Invalid configuration: {exc}")
        st.stop()
    set_state("mo_config", mo)
    st.session_state["mo_running"] = True
    progress = st.progress(0.0, text="Initialising…")
    live = st.empty()

    def on_gen(rec):
        progress.progress(min(rec.generation / mo.generations, 1.0),
                          text=f"Generation {rec.generation}/{mo.generations} · front {rec.front_size} · "
                               f"HV {rec.hypervolume:.3f} · {rec.evaluations_so_far} simulations")
        live.caption("best per objective: " + ", ".join(f"{k}={v:.3f}" for k, v in rec.objective_best.items()))

    with st.spinner("Running NSGA-II…"):
        result, record = run_pareto(base, mo, ExperimentRegistry(), callback=on_gen, notes=notes,
                                    should_stop=lambda: not st.session_state.get("mo_running", True))
    st.session_state["mo_running"] = False
    set_state("pareto_result", result)
    set_state("pareto_record", record)
    progress.empty(); live.empty()
    st.rerun()

result = st.session_state.get("pareto_result")
record = st.session_state.get("pareto_record")
if result is None:
    st.info("Choose objectives and press **Run NSGA-II**. 40 × 25 takes roughly two minutes on a laptop CPU.")
    st.stop()

mo = result.mo_config
front = result.front_frame()
popdf = result.population_frame()
c = st.columns(5)
c[0].metric("Pareto-optimal candidates", len(front))
c[1].metric("2-D hypervolume", f"{result.history[-1].hypervolume:.3f}" if len(mo.objectives) == 2 else "n/a (>2 obj.)")
c[2].metric("Generations", len(result.history) - 1)
c[3].metric("Simulations run", result.evaluations)
c[4].metric("Runtime", f"{result.runtime_seconds:.0f} s")
if record:
    st.success(f"Recorded as **{record['run_id']}** · config hash `{record['configuration_hash']}`")

color_options = ["none"] + [g for g in mo.free_genes] + [o for o in mo.objectives[2:]]
# default to the gene that actually varies along the front (a constant gene gives a useless colour bar)
variances = {g: float(front[g].std()) for g in mo.free_genes if g in front} if len(front) else {}
default_color = max(variances, key=variances.get) if variances and max(variances.values()) > 0 else "none"
color_by = st.selectbox("Colour front by", color_options, index=color_options.index(default_color))
st.plotly_chart(charts.pareto_scatter(front, popdf, mo.objectives, result.baseline.objectives,
                                      None if color_by == "none" else color_by), width="stretch", key="pareto")
if len(mo.objectives) == 2:
    st.plotly_chart(charts.hypervolume_chart(result.history_frame()), width="stretch", key="hv")

st.markdown("#### Pareto front")
st.dataframe(front.style.format(precision=3), hide_index=True, width="stretch", height=320)

st.markdown("#### Pick a point to compare")
idx = st.number_input("Row of the front table (0 = first)", 0, max(len(front) - 1, 0), 0)
row = front.iloc[int(idx)]
spec = GenomeSpec(result.base_config, mo.free_genes)
genome = {g: float(row[g]) for g in spec.names}
st.write({**{k: round(v, 3) for k, v in genome.items()},
          **{o: round(float(row[o]), 3) for o in mo.objectives}})
if st.button("Send this point to the Compare page as 'User-selected'"):
    set_state("compare_user_config", spec.to_config(genome, seed=base.seed))
    st.toast("Sent. Open Compare → Source: 'From Pareto page'.")

st.markdown("#### Export")
c1, c2 = st.columns(2)
c1.download_button("⬇ Pareto result (JSON)", json.dumps(result.to_json_dict(), indent=2, default=_json_default),
                   f"{record['run_id'] if record else 'pareto'}.json", "application/json", width="stretch")
c2.download_button("⬇ Front (CSV)", front.to_csv(index=False),
                   f"{record['run_id'] if record else 'pareto'}_front.csv", "text/csv", width="stretch")
st.caption("Every point is a model output. The front shows which trade-offs the *model* permits under "
           "the stated assumptions, not which one is biologically right.")
