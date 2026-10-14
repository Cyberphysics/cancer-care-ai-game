"""Make `main` and `app` importable when pytest runs from the repo root."""

import sys
from pathlib import Path

AGENT_DIR = Path(__file__).parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))
