"""FastAPI backend for the Telomere Evolution Lab.

This package wraps the existing ``telomere_lab`` service layer
(``telomere_lab.experiments.runner``) in a REST API and serves the built
React frontend (``frontend/dist``). It does not reimplement any
simulation/optimization logic -- see ``docs/API.md`` for the full contract.
"""
