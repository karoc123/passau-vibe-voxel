"""Moved: `uv run python scripts/check.py windows [STEP ...] [--covers C,C]` (on the fixture map,
scripts/fixtures/altstadt.json). This shim keeps the old usage: window_check.py STEP [COVER ...].
"""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    step, covers = sys.argv[1:2], sys.argv[2:]
    sys.exit(subprocess.call([sys.executable, str(Path(__file__).with_name("check.py")), "windows", *step,
                              *(["--covers", ",".join(covers)] if covers else [])]))
