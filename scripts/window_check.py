"""Check that a windowed step (window.py) writes the same bytes over any cover of the map: runs it once over the whole
map and once per cover given, each in a scratch copy of what it reads and writes, and compares every output file.

usage: uv run python scripts/window_check.py STEP [COVER ...]   (from the repo root, after a full build)
  STEP   zones | terrain | tile_fields | tiles_lod
  COVER  NXxNY (--windows) or a size in metres (--window-size); default 2x2 3x1 1024
Exits 1 if any output differs. Scratch copies in data/window_check/ (removed after).
"""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = "web/public/data"
# per step: what it reads (copied: the step rewrites some in place; or linked), what it writes
STEPS = {
    "zones": dict(copy=[f"{PUB}/meta.json"], link=["data/raw", "data/footprints.npz"],
                  out=["data/zones.bin", f"{PUB}/zones.json"]),
    "terrain": dict(copy=[f"{PUB}/meta.json"], link=["data/ground.npz"],
                    out=["data/terrain.bin", f"{PUB}/terrain"]),
    "tile_fields": dict(copy=[f"{PUB}/meta.json", f"{PUB}/tiles", f"{PUB}/windows.bin"],
                        link=["data/zones.bin", "data/flood.bin", "data/foliage.bin"], out=[f"{PUB}/tiles", f"{PUB}/meta.json"]),
    "tiles_lod": dict(copy=[f"{PUB}/meta.json", f"{PUB}/tiles"], link=[], out=[f"{PUB}/tiles", f"{PUB}/meta.json"]),
}


def digest(root, outs):
    h = {}
    for o in outs:
        p = root / o
        for f in sorted([p] if p.is_file() else p.rglob("*")):
            if f.is_file():
                h[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return h


def run(step, args, scratch):
    spec = STEPS[step]
    if scratch.exists():
        shutil.rmtree(scratch)
    for p in spec["copy"]:
        (scratch / p).parent.mkdir(parents=True, exist_ok=True)
        (shutil.copytree if (ROOT / p).is_dir() else shutil.copy)(ROOT / p, scratch / p)
    for p in spec["link"]:
        (scratch / p).parent.mkdir(parents=True, exist_ok=True)
        (scratch / p).symlink_to(ROOT / p)
    (scratch / "data").mkdir(exist_ok=True)
    subprocess.run([sys.executable, str(ROOT / "scripts" / f"{step}.py"), *args], cwd=scratch, check=True,
                   env={"PYTHONPATH": str(ROOT / "scripts"), "PATH": "/usr/bin:/bin"}, stdout=subprocess.DEVNULL)
    return digest(scratch, spec["out"])


def main():
    step, covers = sys.argv[1], sys.argv[2:] or ["2x2", "3x1", "1024"]
    base = ROOT / "data" / "window_check"
    ref = run(step, [], base / "whole")
    print(f"{step}: whole map, {len(ref)} files")
    bad = 0
    for c in covers:
        got = run(step, ["--windows", c] if "x" in c else ["--window-size", c], base / c)
        diff = sorted(k for k in set(ref) | set(got) if ref.get(k) != got.get(k))
        bad += len(diff)
        print(f"{step}: {c}: {len(got)} files, {len(diff)} differ from the whole map's", diff[:5])
    shutil.rmtree(base)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
