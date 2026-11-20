"""Check that the palette registry (scripts/palette.json) is append-only against a git revision: every entry the
revision has keeps its id and its value, new ones only follow them (docs/adr/0002-addressing.md: an edit's palette id
must mean the same colour in every build). Also that web/public/data/meta.json's palette is the registry's first
entries, where there is one.

Not part of overrides.py check: overrides.py is loaded by the region builds (region_inputs.deps_of_process), and any
change to it would rebuild every region.

usage: uv run python scripts/palette_check.py [REV]     (REV: default HEAD)
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def check(rev="HEAD"):
    errs = []
    now = json.loads((HERE / "palette.json").read_text())["palette"]
    r = subprocess.run(["git", "show", f"{rev}:scripts/palette.json"], cwd=HERE, capture_output=True, text=True)
    if r.returncode:
        print(f"palette_check: no scripts/palette.json at {rev}, nothing to compare")
        old = []
    else:
        old = json.loads(r.stdout)["palette"]
    if len(now) < len(old):
        errs.append(f"{len(old) - len(now)} entries removed ({rev} has {len(old)}, now {len(now)})")
    bad = [i for i, (a, b) in enumerate(zip(old, now)) if a != b]
    for i in bad[:10]:
        errs.append(f"id {i} changed: {old[i]} -> {now[i]}")
    if len(bad) > 10:
        errs.append(f"... {len(bad)} changed in all")
    meta = HERE.parent / "web/public/data/meta.json"
    if meta.exists():
        mp = json.loads(meta.read_text()).get("palette", [])
        if mp != now[:len(mp)]:
            errs.append("meta.json palette is not the registry's first entries")
    for e in errs:
        print("palette_check:", e)
    if not errs:
        print(f"palette_check: ok, {len(old)} entries as at {rev}, {len(now) - len(old)} appended")
    return not errs


if __name__ == "__main__":
    sys.exit(0 if check(*sys.argv[1:2]) else 1)
