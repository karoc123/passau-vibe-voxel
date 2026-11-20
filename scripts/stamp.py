"""Run a pipeline step only when what it reads or writes changed since it last ran (scripts/build_data.sh).

usage: python scripts/stamp.py NAME -i INPUT ... -o OUTPUT ... -- COMMAND ...

The step's record (data/cache/stamps/NAME.json) holds the signatures of its inputs and outputs as they were when it
finished, and its command. It runs again when any of them differs now, or an output is missing; FORCE=1 (or
FORCE=NAME,NAME) runs it anyway. Signatures: a file's content hash (cached per size and mtime, region_inputs.file_sha;
`path#-a.b,c.d` leaves out keys of a JSON file: meta.json's tiles.bytes and tiles.tris, which tile_fields.py and
web/tools/tris.mjs write after the steps that read meta.json), a folder's names, sizes and mtimes (the tiles: thousands
of files). A step that changes its own input in place (tile_fields.py the tiles) is recorded after it ran, so it is up to date afterwards.
The step's own script (the first argument after `python` or `node` ending in .py or .mjs) is an input by itself.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import region_inputs  # noqa: E402

DB = Path("data/cache/stamps")


def _plain(v):
    """a JSON value as Python and node write it alike (meta.json is rewritten by both: 1.0 and -0.0 come back as 1, 0)"""
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def sig(spec):
    path, _, skip = spec.partition("#-")
    p = Path(path)
    if not p.exists():
        return None
    if p.is_dir():
        h = hashlib.sha256()
        for f in sorted(p.rglob("*")):
            if f.is_file():
                st = f.stat()
                h.update(f"{f.relative_to(p)}:{st.st_size}:{st.st_mtime_ns}\n".encode())
        return "dir:" + h.hexdigest()
    if skip:
        d = json.load(open(p))
        for key in skip.split(","):
            *outer, last = key.split(".")
            o = d
            for k in outer:
                o = o.get(k, {})
            o.pop(last, None)
        return "json:" + region_inputs.sha(json.dumps(_plain(d), sort_keys=True).encode())
    return region_inputs.file_sha(p)


def main(argv):
    name = argv[0]
    cut = argv.index("--")
    opts, cmd = argv[1:cut], argv[cut + 1:]
    ins, outs, cur = [], [], None
    for a in opts:
        if a in ("-i", "-o"):
            cur = ins if a == "-i" else outs
        else:
            cur.append(a)
    ins += [a for a in cmd[1:2] if a.endswith((".py", ".mjs"))]
    f = DB / f"{name}.json"
    force = os.environ.get("FORCE", "")
    rec = json.load(open(f)) if f.exists() else None
    now = dict(cmd=cmd, ins={p: sig(p) for p in ins}, outs={p: sig(p) for p in outs})
    if rec == now and all(v is not None for v in now["outs"].values()) and not (force == "1" or name in force.split(",")):
        print(f"[{name}] up to date")
        return 0
    t0 = time.time()
    f.unlink(missing_ok=True)
    r = subprocess.run(cmd)
    if r.returncode:
        return r.returncode
    DB.mkdir(parents=True, exist_ok=True)
    json.dump(dict(cmd=cmd, ins={p: sig(p) for p in ins}, outs={p: sig(p) for p in outs}), open(f, "w"), indent=0)
    print(f"[{name}] {time.time() - t0:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
