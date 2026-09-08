"""UI helper package. Importing it makes ``telomere_lab`` importable even when
the project has not been ``pip install -e .``-ed (SDD §27 headless-friendly)."""

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parents[2] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
