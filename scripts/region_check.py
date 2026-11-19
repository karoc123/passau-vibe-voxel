"""Check that voxelize.py builds the same map region by region as in one piece (scripts/region.py): runs it over the
whole map and once per cover given, each in a scratch copy of its inputs and outputs, then the steps after it, and
compares every output: the files of web/public/data, the arrays of data/*.npz, data/*.bin.

usage: uv run python scripts/region_check.py [COVER ...] [--steps voxelize|all] [-j JOBS] [--keep]
  COVER  NXxNY (--regions) or a size in metres (--region-size); default 3x2 1024
  --steps all (default): voxelize.py and the Python steps after it (places flood boats terrain zones windows phenology
         tile_fields; not climate.py, which fetches); voxelize: voxelize.py alone
Exits 1 if any output differs. Scratch copies in data/region_check/ (removed after, unless --keep). Needs the inputs of
voxelize.py in data/ (prep.npz, lod2.npz, laser.npz, raw/) and ~8 GB of RAM (the whole map in one region).
"""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PUB = "web/public/data"
LINK = ["data/raw", "data/prep.npz", "data/lod2.npz", "data/laser.npz"]
AFTER = ["places", "flood", "boats", "terrain", "zones", "windows", "phenology", "tile_fields"]


def digest(root):
    h = {}
    for f in sorted((root / PUB).rglob("*")):  # (the registry, scripts/palette.json, is meta.json's palette)
        if f.is_file():
            h[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    for f in sorted((root / "data").glob("*")):
        if f.is_symlink() or not f.is_file():
            continue
        if f.suffix == ".npz":  # (the arrays: a zip's entries carry the time they were written)
            z = np.load(f)
            for k in sorted(z.files):
                a = z[k]
                h[f"{f.relative_to(root)}:{k}"] = hashlib.sha256(str((a.dtype, a.shape)).encode() + a.tobytes()).hexdigest()
        elif f.suffix == ".bin":
            h[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return h


def run(args, scratch, steps, jobs, palette=None):
    """the steps in scratch, with a copy of scripts/ (some steps write beside their script: places.py, windows.py,
    phenology.py); palette: the registry to start from (the whole map's run's, so that both have the same ids)"""
    if scratch.exists():
        shutil.rmtree(scratch)
    shutil.copytree(ROOT / "scripts", scratch / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    if palette is not None:
        shutil.copy(palette, scratch / "scripts" / "palette.json")
    (scratch / PUB).mkdir(parents=True)
    shutil.copy(ROOT / PUB / "windows.json", scratch / PUB / "windows.json")  # (not built here)
    for p in LINK:
        if (ROOT / p).exists():
            (scratch / p).parent.mkdir(parents=True, exist_ok=True)
            (scratch / p).symlink_to((ROOT / p).resolve())
    env = {"PYTHONPATH": str(scratch / "scripts"), "PATH": "/usr/bin:/bin"}
    for s in ["voxelize"] + (AFTER if steps == "all" else []):
        a = args + ["-j", str(jobs)] if s == "voxelize" else []
        subprocess.run([sys.executable, str(scratch / "scripts" / f"{s}.py"), *a], cwd=scratch, check=True, env=env,
                       stdout=open(scratch / f"log_{s}.txt", "w"), stderr=subprocess.STDOUT)
    return digest(scratch)


def main():
    argv = sys.argv[1:]
    steps = argv[argv.index("--steps") + 1] if "--steps" in argv else "all"
    jobs = int(argv[argv.index("-j") + 1]) if "-j" in argv else 1
    covers = [a for i, a in enumerate(argv) if not a.startswith("-") and (i == 0 or argv[i - 1] not in ("--steps", "-j"))]
    base = ROOT / "data" / "region_check"
    ref = run([], base / "whole", steps, 1)
    print(f"whole map: {len(ref)} outputs")
    bad = 0
    for c in covers or ["3x2", "1024"]:
        got = run(["--regions", c] if "x" in c else ["--region-size", c], base / c, steps, jobs,
                  palette=base / "whole" / "scripts" / "palette.json")
        diff = sorted(k for k in set(ref) | set(got) if ref.get(k) != got.get(k))
        bad += len(diff)
        print(f"{c}: {len(got)} outputs, {len(diff)} differ from the whole map's", diff[:8])
    if "--keep" not in argv:
        shutil.rmtree(base)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
