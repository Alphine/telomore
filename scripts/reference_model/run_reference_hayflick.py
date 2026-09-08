"""Run inside a checkout of https://github.com/anais-rat/telomeres (GPLv3),
in ITS OWN Python 3.12 environment — never inside telomere-evolution-lab's.

Computes, per founding cell, the generation at which it (or one of its
descendants) first became senescent, using the model's own
`population_init` / `population_evolution` and its own default best-fit
parameters (`telomeres.model.parameters.PAR_DEFAULT_POP`). Writes a plain
JSON file of numbers (no source code) for comparison in the other repo.

    python run_reference_hayflick.py
"""

import json
import time

import numpy as np

import telomeres.model.parameters as par
from telomeres.population.simulation import population_evolution, population_init

SEED = 11
N = 80
DAY_COUNT = 10
TIMES_PER_DAY = 100

rng = np.random.default_rng(SEED)
dic_s = population_init(np.array([N]), par.PAR_L_INIT, rng)
cells_data = dic_s[0]

times = np.linspace(0, DAY_COUNT * 24 * 60, DAY_COUNT * TIMES_PER_DAY + 1)
time_saved_idxs = np.arange(0, len(times), 10)

t0 = time.perf_counter()
out = population_evolution(
    times, time_saved_idxs, N, cells_data, par.PAR_DEFAULT_POP,
    cell_count_max=20000, rng=rng,
)
elapsed = time.perf_counter() - t0

ancestors_final = out["ancestors"]
gens_final = out["generations"]
sen_final = out["sen_counts"] > 0
hist_dead = out["history_dead"]  # (n_dead, 4): ancestor, generation, death_time_days, type

# First-passage generation of senescence per ancestor (ties = earliest
# evidence available), combining currently-senescent living cells and cells
# that already died. NB: for ancestors only represented via `history_dead`,
# this slightly *overestimates* the true senescence-onset generation by
# however many senescent cycles the cell survived before dying (p_death is
# checked once per cycle while senescent) - see scripts/reference_model/README.md.
gen_by_anc = {}
for anc, gen in zip(ancestors_final[sen_final], gens_final[sen_final]):
    a = int(anc)
    gen_by_anc[a] = min(gen_by_anc.get(a, np.inf), gen)
for row in hist_dead:
    a, gen = int(row[0]), row[1]
    gen_by_anc[a] = min(gen_by_anc.get(a, np.inf), gen)

observed = np.array(sorted(gen_by_anc.values()))
censored = N - len(observed)
print(f"runtime={elapsed:.1f}s  observed={len(observed)}/{N}  censored={censored}")
if len(observed):
    print(f"mean={observed.mean():.2f} median={np.median(observed):.2f} std={observed.std():.2f}")

json.dump({
    "source": "anais-rat/telomeres (GPLv3), population_evolution, default best-fit parameters",
    "seed": SEED, "n_founders": N, "day_count": DAY_COUNT,
    "runtime_seconds": elapsed, "extinction_time": out["extinction_time"],
    "generations_at_senescence_or_death": observed.tolist(),
    "n_censored": int(censored),
    "overhang_bp": par.OVERHANG,
    "par_sen_a": list(par.PAR_SEN_A), "par_sen_b": list(par.PAR_SEN_B),
    "par_nta": list(par.PAR_NTA), "p_death": par.P_DEATH, "p_repair": par.P_REPAIR,
}, open("reference_hayflick.json", "w"), indent=2)
print("written: reference_hayflick.json")
