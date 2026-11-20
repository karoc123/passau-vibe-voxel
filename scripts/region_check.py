"""Moved: `uv run python scripts/check.py covers [COVER ...]` (on the fixture map, scripts/fixtures/altstadt.json, not
the whole map: the whole map as one region took ~8 GB and half an hour). This shim passes its arguments on
(--steps is gone: the steps after voxelize.py always run).
"""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--steps" in argv:
        i = argv.index("--steps")
        argv = argv[:i] + argv[i + 2:]
    sys.exit(subprocess.call([sys.executable, str(Path(__file__).with_name("check.py")), "covers", *argv]))
