"""Plotly figures. All lengths displayed in kb; time in cell cycles."""

from __future__ import annotations

from typing import Dict, Iterable, Sequence

import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from telomere_lab.schemas import SimulationResult

PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2"]
_LAYOUT = dict(template="plotly_white", margin=dict(l=40, r=20, t=50, b=40), height=340,
               legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0))


def _kb(x: np.ndarray) -> np.ndarray:
    return np.asarray(x, dtype=float) / 1000.0


def length_trajectory(result: SimulationResult) -> go.Figure:
    fig = go.Figure()
    t = result.time
    fig.add_trace(go.Scatter(x=t, y=_kb(result.mean_length), name="mean", line=dict(color=PALETTE[0], width=2)))
    fig.add_trace(go.Scatter(x=t, y=_kb(result.median_length), name="median",
                             line=dict(color=PALETTE[2], dash="dot")))
    fig.add_trace(go.Scatter(x=t, y=_kb(result.p10_length), name="10th percentile",
                             line=dict(color=PALETTE[3], dash="dash")))
    fig.add_trace(go.Scatter(x=t, y=_kb(result.shortest_length), name="shortest telomere",
                             line=dict(color=PALETTE[1])))
    fig.add_hline(y=result.config.senescence_threshold / 1000, line=dict(color="gray", dash="dash"),
                  annotation_text="senescence threshold", annotation_position="bottom right")
    fig.update_layout(title="Telomere length over time", xaxis_title="cell cycle",
                      yaxis_title="length (kb)", **_LAYOUT)
    return fig


def length_distribution(result: SimulationResult) -> go.Figure:
    fig = go.Figure()
    snaps = result.distribution_snapshots or {result.config.cycles: result.final_lengths}
    keys = sorted(snaps)
    show = keys if len(keys) <= 6 else [keys[0]] + keys[-5:]
    for i, k in enumerate(show):
        vals = _kb(snaps[k])
        if vals.size == 0:
            continue
        fig.add_trace(go.Histogram(x=vals, name=f"cycle {k}", opacity=0.55, nbinsx=40,
                                   marker_color=PALETTE[i % len(PALETTE)]))
    fig.add_vline(x=result.config.senescence_threshold / 1000, line=dict(color="gray", dash="dash"))
    fig.update_layout(title="Telomere length distribution", xaxis_title="length (kb)",
                      yaxis_title="telomere count", barmode="overlay", **_LAYOUT)
    return fig


def senescence_curve(result: SimulationResult) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=result.time, y=result.senescent_fraction, name="senescent fraction",
                             fill="tozeroy", line=dict(color=PALETTE[1])))
    fig.add_trace(go.Scatter(x=result.time, y=result.fraction_below_threshold,
                             name="telomeres below threshold", line=dict(color=PALETTE[3], dash="dot")))
    fig.update_layout(title="Senescence over time", xaxis_title="cell cycle", yaxis_title="fraction",
                      yaxis_range=[0, 1.02], **_LAYOUT)
    return fig


def population_curve(result: SimulationResult) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=result.time, y=result.population_size, name="living cells",
                             line=dict(color=PALETTE[0], width=2)))
    fig.add_trace(go.Scatter(x=result.time, y=result.proliferative_count, name="proliferative cells",
                             line=dict(color=PALETTE[2]), fill="tozeroy"))
    fig.add_hline(y=result.config.carrying_capacity, line=dict(color="gray", dash="dash"),
                  annotation_text="carrying capacity", annotation_position="bottom right")
    fig.update_layout(title="Population over time", xaxis_title="cell cycle", yaxis_title="cells", **_LAYOUT)
    return fig


def fitness_breakdown_bar(breakdown: Dict[str, float], weights: Dict[str, float]) -> go.Figure:
    comps = [
        ("survival", weights["w_survival"] * breakdown["survival"]),
        ("reserve", weights["w_reserve"] * breakdown["reserve"]),
        ("senescence", -weights["w_senescence"] * breakdown["senescence"]),
        ("instability", -weights["w_instability"] * breakdown["instability"]),
        ("cost", -weights["w_cost"] * breakdown["cost"]),
    ]
    fig = go.Figure(go.Bar(x=[c[0] for c in comps], y=[c[1] for c in comps],
                           marker_color=[PALETTE[2] if v >= 0 else PALETTE[1] for _, v in comps]))
    fig.update_layout(title=f"Weighted fitness contributions (total {breakdown['total']:+.3f})",
                      yaxis_title="contribution", **{**_LAYOUT, "height": 280, "showlegend": False})
    return fig


# --------------------------------------------------------------- evolution
def evolution_fitness_chart(history) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=history["generation"], y=history["best_fitness"], name="best",
                             line=dict(color=PALETTE[0], width=2), mode="lines+markers"))
    fig.add_trace(go.Scatter(x=history["generation"], y=history["mean_fitness"], name="mean",
                             line=dict(color=PALETTE[3], dash="dot")))
    fig.add_trace(go.Scatter(x=history["generation"], y=history["median_fitness"], name="median",
                             line=dict(color=PALETTE[2], dash="dash")))
    fig.update_layout(title="Fitness by generation", xaxis_title="generation", yaxis_title="fitness", **_LAYOUT)
    return fig


def diversity_chart(history) -> go.Figure:
    fig = go.Figure(go.Scatter(x=history["generation"], y=history["diversity"], name="diversity",
                               line=dict(color=PALETTE[4]), fill="tozeroy"))
    fig.update_layout(title="Population diversity (mean gene SD, normalised)", xaxis_title="generation",
                      yaxis_title="diversity", **{**_LAYOUT, "showlegend": False})
    return fig


def parameter_trajectory_chart(history, genes: Sequence[str]) -> go.Figure:
    from telomere_lab.schemas import PARAMETER_BOUNDS

    fig = go.Figure()
    for i, g in enumerate(genes):
        lo, hi = PARAMETER_BOUNDS[g][0], PARAMETER_BOUNDS[g][1]
        norm = (history[f"best_{g}"] - lo) / (hi - lo)
        fig.add_trace(go.Scatter(x=history["generation"], y=norm, name=g, mode="lines+markers",
                                 line=dict(color=PALETTE[i % len(PALETTE)]),
                                 customdata=history[f"best_{g}"],
                                 hovertemplate=f"{g}: %{{customdata:.3f}}<extra></extra>"))
    fig.update_layout(title="Best candidate's parameters (normalised to gene bounds)",
                      xaxis_title="generation", yaxis_title="position in [min, max]",
                      yaxis_range=[-0.02, 1.02], **_LAYOUT)
    return fig


# ------------------------------------------------------------------ pareto
def pareto_scatter(front, population, objectives: Sequence[str], baseline: Dict[str, float] | None = None,
                   color_gene: str | None = None) -> go.Figure:
    """2-D Pareto front (first two objectives); third objective / gene as colour."""
    from telomere_lab.schemas import OBJECTIVES

    ox, oy = objectives[0], objectives[1]
    fig = go.Figure()
    if population is not None and len(population):
        dom = population[population["rank"] > 0] if "rank" in population else population
        fig.add_trace(go.Scatter(x=dom[ox], y=dom[oy], mode="markers", name="dominated candidates",
                                 marker=dict(color="#9ca3af", size=7, opacity=0.5)))
    if front is not None and len(front):
        f = front.sort_values(ox)
        hover = [f"<b>{ox}</b> %s<br><b>{oy}</b> %s" % (f"{row[ox]:.3f}", f"{row[oy]:.3f}") +
                 "".join(f"<br>{g}: {row[g]:.3f}" for g in f.columns if g in
                         ("stress_level", "maintenance_rate", "repair_rate", "shortening_rate",
                          "initial_length", "senescence_threshold"))
                 for _, row in f.iterrows()]
        marker = dict(size=11, line=dict(width=1, color="white"))
        if color_gene and color_gene in f:
            marker.update(color=f[color_gene], colorscale="Viridis", showscale=True,
                          colorbar=dict(title=color_gene, thickness=12))
        else:
            marker.update(color=PALETTE[0])
        fig.add_trace(go.Scatter(x=f[ox], y=f[oy], mode="lines+markers", name="Pareto front",
                                 line=dict(color=PALETTE[0], width=1.5, dash="dot"), marker=marker,
                                 text=hover, hovertemplate="%{text}<extra>Pareto</extra>"))
    if baseline is not None:
        fig.add_trace(go.Scatter(x=[baseline[ox]], y=[baseline[oy]], mode="markers", name="baseline",
                                 marker=dict(symbol="x", size=14, color=PALETTE[1], line=dict(width=2))))
    fig.update_layout(
        title="Pareto front (model outputs)",
        xaxis_title=f"{ox} ({OBJECTIVES[ox][0]}imise)", yaxis_title=f"{oy} ({OBJECTIVES[oy][0]}imise)",
        **{**_LAYOUT, "height": 460},
    )
    return fig


def hypervolume_chart(history) -> go.Figure:
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(go.Scatter(x=history["generation"], y=history["hypervolume"], name="hypervolume",
                             line=dict(color=PALETTE[0], width=2), mode="lines+markers"))
    fig.add_trace(go.Scatter(x=history["generation"], y=history["front_size"], name="front size",
                             line=dict(color=PALETTE[3], dash="dot")), secondary_y=True)
    fig.update_layout(title="Front quality by generation", xaxis_title="generation", **_LAYOUT)
    fig.update_yaxes(title_text="2-D hypervolume", secondary_y=False)
    fig.update_yaxes(title_text="non-dominated candidates", secondary_y=True)
    return fig


# -------------------------------------------------------------- sensitivity
def tornado_chart(frame) -> go.Figure:
    """Horizontal bar per parameter, diverging from baseline fitness, sorted by |swing|."""
    if frame is None or len(frame) == 0:
        return go.Figure()
    df = frame.iloc[::-1]  # largest |swing| at the top
    baseline = df["fitness_baseline"].iloc[0]
    low = df["fitness_low"] - baseline
    high = df["fitness_high"] - baseline
    fig = go.Figure()
    fig.add_trace(go.Bar(y=df["parameter"], x=low, orientation="h", name="-10%",
                         marker_color=PALETTE[1], base=baseline))
    fig.add_trace(go.Bar(y=df["parameter"], x=high, orientation="h", name="+10%",
                         marker_color=PALETTE[2], base=baseline))
    fig.add_vline(x=baseline, line=dict(color="gray", dash="dash"))
    fig.update_layout(title="Fitness sensitivity (one-at-a-time perturbation)", barmode="overlay",
                      xaxis_title="fitness", yaxis_title="parameter",
                      **{**_LAYOUT, "height": max(280, 60 + 40 * len(df))})
    return fig


# -------------------------------------------------------------- benchmark
def convergence_comparison_chart(frame) -> go.Figure:
    """One line per optimizer method: n_evaluations vs. best_fitness_so_far."""
    fig = go.Figure()
    if frame is None or len(frame) == 0:
        return fig
    for i, method in enumerate(frame["method"].unique()):
        sub = frame[frame["method"] == method].sort_values("n_evaluations")
        fig.add_trace(go.Scatter(x=sub["n_evaluations"], y=sub["best_fitness_so_far"], name=method,
                                 mode="lines+markers", line=dict(color=PALETTE[i % len(PALETTE)], width=2)))
    fig.update_layout(title="Optimizer convergence (budget-matched)", xaxis_title="simulator evaluations",
                      yaxis_title="best fitness so far", **_LAYOUT)
    return fig


# ----------------------------------------------------------------- compare
def overlay(results: Dict[str, SimulationResult], metric: str, title: str, ylabel: str,
            kb: bool = False, hline: float | None = None) -> go.Figure:
    fig = go.Figure()
    for i, (name, r) in enumerate(results.items()):
        y = getattr(r, metric)
        fig.add_trace(go.Scatter(x=r.time, y=_kb(y) if kb else y, name=name,
                                 line=dict(color=PALETTE[i % len(PALETTE)], width=2)))
    if hline is not None:
        fig.add_hline(y=hline, line=dict(color="gray", dash="dash"))
    fig.update_layout(title=title, xaxis_title="cell cycle", yaxis_title=ylabel, **_LAYOUT)
    return fig


def comparison_grid(results: Dict[str, SimulationResult]) -> go.Figure:
    fig = make_subplots(rows=1, cols=3, subplot_titles=(
        "mean shortest telomere / cell (kb)", "senescent fraction", "proliferative cells"))
    for i, (name, r) in enumerate(results.items()):
        color = PALETTE[i % len(PALETTE)]
        fig.add_trace(go.Scatter(x=r.time, y=_kb(r.mean_shortest_per_cell), name=name,
                                 line=dict(color=color), legendgroup=name), row=1, col=1)
        fig.add_trace(go.Scatter(x=r.time, y=r.senescent_fraction, name=name, showlegend=False,
                                 line=dict(color=color), legendgroup=name), row=1, col=2)
        fig.add_trace(go.Scatter(x=r.time, y=r.proliferative_count, name=name, showlegend=False,
                                 line=dict(color=color), legendgroup=name), row=1, col=3)
    fig.update_layout(**{**_LAYOUT, "height": 360, "title": "Scenario overlay (model outputs)"})
    return fig
