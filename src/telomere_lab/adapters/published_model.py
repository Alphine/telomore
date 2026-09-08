"""Model adapter protocol and the optional published-model adapter (SDD §23).

The GUI, CLI and optimizer only depend on :class:`TelomereModelAdapter`.
``SimpleTelomereModel`` is the MVP implementation.
``PublishedTelomereModelAdapter`` documents the extension point for the
reference implementation named in the SDD, ``anais-rat/telomeres``
(simulation of cell populations and lineages during replicative
senescence), which has now been inspected first-hand:

- Repository: https://github.com/anais-rat/telomeres
  (commit ``69191c55768477a8c9dc03e111e5e6b194545b69``, fetched 2026-09-08)
- License: **GPLv3** (copyleft) - this MIT-licensed package must never
  import it directly; see ``scripts/reference_model/README.md`` for the
  process-isolation strategy actually used.
- Requires Python 3.12 (pinned by its own ``pyproject.toml``), not the
  3.11+ this package targets.
- It is the exact published model of replicative senescence in
  telomerase-negative *Saccharomyces cerevisiae* (per-chromosome,
  stochastic senescence-probability law, fit to single-cell time-lapse
  data) - not a general-purpose tunable simulator comparable parameter-
  for-parameter to ``SimpleTelomereModel``.

A real Level-3 comparison (generations-to-senescence distribution shape,
via first-passage per founding cell) has been run and is documented in
``docs/EXPERIMENT_PROTOCOL.md`` (Experiment D) using the isolated-process
approach: the reference repo's own script
(``scripts/reference_model/run_reference_hayflick.py``) is run inside its
own Python 3.12 / GPLv3 environment, writes a small JSON of plain numbers,
and ``scripts/compare_reference_model.py`` (MIT, no GPLv3 import) reads it
back alongside our own model's output.

This adapter class remains a Protocol-conformant *stub* for in-process use:
calling ``.simulate()`` deliberately raises, because wrapping the reference
model behind ``ModelConfig`` would misrepresent it as parameter-compatible
with ``SimpleTelomereModel`` when it structurally is not (different
organism, per-chromosome state, stochastic multi-pathway senescence vs. a
single deterministic threshold).
"""

from __future__ import annotations

import importlib
from typing import Dict, Protocol, runtime_checkable

from ..schemas import ModelConfig, SimulationResult
from ..simulator.model import SimpleTelomereModel

REFERENCE_REPOSITORY = "https://github.com/anais-rat/telomeres"
REFERENCE_COMMIT = "69191c55768477a8c9dc03e111e5e6b194545b69"
REFERENCE_LICENSE = "GPLv3"


@runtime_checkable
class TelomereModelAdapter(Protocol):
    name: str
    version: str

    def simulate(self, config: ModelConfig) -> SimulationResult: ...


class PublishedTelomereModelAdapter:
    """Documents the reference model; deliberately does not wrap it in-process.

    ``is_available()`` reports whether a package literally named
    ``telomeres`` is importable in the *current* environment (it normally
    won't be - the reference repo is GPLv3 and must be installed, if at
    all, in its own separate Python 3.12 environment; see the module
    docstring and ``scripts/reference_model/README.md``).
    """

    name = "published-telomeres-adapter"
    version = "0.1.0-documented-stub"
    module_candidates = ("telomeres",)

    def __init__(self) -> None:
        self._module = None
        for candidate in self.module_candidates:
            try:
                self._module = importlib.import_module(candidate)
                break
            except ImportError:
                continue

    def is_available(self) -> bool:
        return self._module is not None

    def simulate(self, config: ModelConfig) -> SimulationResult:  # pragma: no cover - stub
        raise NotImplementedError(
            f"{REFERENCE_REPOSITORY} (commit {REFERENCE_COMMIT[:12]}, {REFERENCE_LICENSE}) is a "
            "structurally different, GPLv3-licensed model (per-chromosome, stochastic "
            "senescence-probability law fit to S. cerevisiae single-cell data) and is "
            "intentionally never imported into this MIT-licensed process. It cannot be wrapped "
            "as a drop-in ModelConfig-compatible adapter. For the real, executed comparison, see "
            "scripts/reference_model/README.md and docs/EXPERIMENT_PROTOCOL.md (Experiment D)."
        )


_REGISTRY: Dict[str, type] = {
    SimpleTelomereModel.name: SimpleTelomereModel,
    PublishedTelomereModelAdapter.name: PublishedTelomereModelAdapter,
}


def available_models() -> Dict[str, str]:
    """name -> status string, for display in the GUI."""
    out = {SimpleTelomereModel.name: "available (MVP reference model)"}
    out[PublishedTelomereModelAdapter.name] = (
        f"documented, not wrapped in-process (GPLv3, isolated comparison in "
        f"docs/EXPERIMENT_PROTOCOL.md Experiment D)"
    )
    return out


def get_model(name: str = SimpleTelomereModel.name) -> TelomereModelAdapter:
    if name not in _REGISTRY:
        raise KeyError(f"unknown model '{name}'. Known: {sorted(_REGISTRY)}")
    return _REGISTRY[name]()
