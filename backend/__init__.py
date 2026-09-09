"""FastAPI backend for the Telomere Evolution Lab (Phase 1 of the Streamlit -> React migration).

This package wraps the existing ``telomere_lab`` service layer
(``telomere_lab.experiments.runner``) in a REST API. It does not reimplement
any simulation/optimization logic -- see ``docs/API.md`` for the full
contract and ``app/`` (untouched) for the still-live Streamlit UI.
"""
