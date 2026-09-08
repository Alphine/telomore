"""Page 7 - Active Learning: surrogate-model (GP + Expected Improvement) active
learning, an alternative to GA/NSGA-II/random search that spends its real-simulator
budget on a small random initial design plus surrogate-guided picks."""

import json

import pandas as pd
import streamlit as st

import ui  # noqa: F401
from ui import charts
from ui.components import (
    baseline_config, current_user, disclaimer, page_setup, require_login, set_state, weights,
)

from telomere_lab import db as _db
from telomere_lab.evolution.benchmark import run_random_search
from telomere_lab.experiments.registry import ExperimentRegistry, _json_default
from telomere_lab.experiments.runner import run_active_learning
from telomere_lab.schemas import EVOLVABLE_PARAMETERS, ActiveLearningConfig

page_setup("Active Learning", "🧭")
disclaimer()
require_login()

base = baseline_config()
st.markdown(
    "**Surrogate-model active learning.** Instead of evaluating every candidate with the real "
    "simulator, a small random *initial design* is evaluated for real, a cheap Gaussian-process "
    "surrogate is fit to those (genome → fitness) pairs, and **Expected Improvement** picks which "
    "untested configuration is most worth the next real evaluation. Refit, repeat. The question this "
    "answers: can we reach comparable fitness with **fewer real simulator evaluations** than random "
    "search or a full population-based search (GA/NSGA-II, see the **Evolve** and **Pareto** pages)?"
)
st.caption(
    f"Baseline: stress {base.stress_level:.2f} · maintenance {base.maintenance_rate:.2f} · repair "
    f"{base.repair_rate:.2f} · {base.cycles} cycles. Change it on the Simulate page."
)

defaults = st.session_state.get("active_learning_config") or ActiveLearningConfig(weights=weights())

with st.form("active_learning_form"):
    free_genes = st.multiselect("Free genes (searched by the optimizer)", list(EVOLVABLE_PARAMETERS),
                                list(defaults.free_genes))
    c1, c2, c3 = st.columns(3)
    n_initial = c1.number_input("Initial random design size", 2, 100, int(defaults.n_initial))
    n_iterations = c2.number_input("Active-learning iterations", 0, 200, int(defaults.n_iterations))
    xi = c3.number_input("Expected Improvement margin (xi)", 0.0, 0.5, float(defaults.xi), 0.01)
    c4, c5 = st.columns(2)
    seeds = c4.text_input("Simulator seeds to average (comma-separated)",
                          ",".join(str(s) for s in defaults.eval_seeds))
    seed = c5.number_input("Optimizer random seed", 0, 10_000, int(defaults.seed))
    notes = st.text_input("Notes for the ledger", "")
    submitted = st.form_submit_button("🧭 Run active learning", type="primary", width="stretch")

if submitted:
    try:
        eval_seeds = tuple(int(s.strip()) for s in seeds.split(",") if s.strip())
        al = ActiveLearningConfig(
            n_initial=int(n_initial), n_iterations=int(n_iterations),
            eval_seeds=eval_seeds or defaults.eval_seeds,
            free_genes=tuple(free_genes) or defaults.free_genes,
            seed=int(seed), xi=float(xi), weights=weights(),
        ).validate()
    except Exception as exc:  # noqa: BLE001
        st.error(f"Invalid configuration: {exc}")
        st.stop()
    set_state("active_learning_config", al)
    total = al.n_initial + al.n_iterations
    progress = st.progress(0.0, text="Initialising…")
    seen = []

    def on_record(rec):
        seen.append(rec)
        progress.progress(min(len(seen) / max(total, 1), 1.0),
                          text=f"[{rec.phase}] real fitness {rec.real_fitness:+.4f}  "
                               f"best so far {rec.best_so_far:+.4f}  ({len(seen)}/{total})")

    with st.spinner("Running active learning…"):
        result, record = run_active_learning(base, al, ExperimentRegistry(), callback=on_record, notes=notes)
        # Random baseline of the same real-evaluation budget, for an apples-to-apples comparison.
        random_baseline = run_random_search(base, al.free_genes, weights=al.weights,
                                            eval_seeds=al.eval_seeds, n_evaluations=result.evaluations,
                                            seed=al.seed)
    set_state("active_learning_result", result)
    set_state("active_learning_record", record)
    set_state("active_learning_random_baseline", random_baseline)
    if record:
        user = current_user()
        if user is not None:
            _db.record_user_run(user.id, record["run_id"])
    progress.empty()
    st.rerun()

result = st.session_state.get("active_learning_result")
record = st.session_state.get("active_learning_record")
random_baseline = st.session_state.get("active_learning_random_baseline")
if result is None:
    st.info("Choose a budget and press **Run active learning**.")
    st.stop()

frame = result.to_frame()
c = st.columns(4)
c[0].metric("Best fitness found", f"{result.best_fitness:+.3f}")
c[1].metric("Real simulator evaluations", result.evaluations)
c[2].metric("Initial design / iterations", f"{result.al_config.n_initial} / {result.al_config.n_iterations}")
c[3].metric("Runtime", f"{result.runtime_seconds:.1f} s")
if record:
    st.success(f"Recorded as **{record['run_id']}** · config hash `{record['configuration_hash']}`")

st.markdown("#### Convergence vs. a random-search baseline of the same budget")
combined = pd.concat([result.convergence_frame(), random_baseline.to_frame()], ignore_index=True)
st.plotly_chart(charts.convergence_comparison_chart(combined), width="stretch", key="al_convergence")
st.caption(
    f"Random-search baseline (same {random_baseline.evaluations} simulator evaluations, same seed) "
    f"reached best fitness {random_baseline.final_best_fitness:+.3f}. Active learning reached "
    f"{result.best_fitness:+.3f}."
)

st.markdown("#### Iterations: surrogate prediction vs. actual fitness")
st.caption(
    "`predicted_mean`/`predicted_std` are the surrogate's belief **before** the real evaluation "
    "(empty during the random initial design, which has no surrogate yet). Comparing them to "
    "`real_fitness` shows how well-calibrated the surrogate was."
)
show_cols = ["iteration", "phase", "predicted_mean", "predicted_std", "acquisition_value",
            "real_fitness", "best_so_far"]
st.dataframe(frame[show_cols].style.format(precision=4), hide_index=True, width="stretch", height=360)

st.markdown("#### Export")
c1, c2 = st.columns(2)
c1.download_button("⬇ Active learning result (JSON)",
                   json.dumps(result.to_json_dict(), indent=2, default=_json_default),
                   f"{record['run_id'] if record else 'active_learning'}.json", "application/json",
                   width="stretch")
c2.download_button("⬇ Iterations table (CSV)", frame.to_csv(index=False),
                   f"{record['run_id'] if record else 'active_learning'}.csv", "text/csv", width="stretch")
st.caption("This compares one optimizer *technique* (surrogate-guided selective evaluation) against "
          "random search under the same real-evaluation budget — it is not a claim about biology.")
