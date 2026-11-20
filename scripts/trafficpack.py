"""traffic.json's polylines packed: each road's, footpath's and track's points [[x, y, z], ...] (x, y in grid metres to
0.1 m, z a voxel level) as "q", one flat list of whole numbers: the first point's x and y in decimetres and its z, then
each next point's differences to the one before. Less than half the bytes, gzipped too (the viewer loads the file at
startup; web/src/sim/traffic-pack.ts unpacks it there and in web/tools). Exact: x = X / 10 gives back the same floats.

  uv run python scripts/trafficpack.py web/public/data/traffic.json   # packs a file in place (packed already: as is)
"""
import json
import sys

KINDS = ("roads", "peds", "trains")


def pack_points(p):
    out, px, py, pz = [], 0, 0, 0
    for x, y, z in p:
        X, Y, Z = round(x * 10), round(y * 10), int(z)
        assert abs(X - x * 10) < 1e-6 and abs(Y - y * 10) < 1e-6 and Z == z, (x, y, z)
        out += (X - px, Y - py, Z - pz)
        px, py, pz = X, Y, Z
    return out


def unpack_points(q):
    p, X, Y, Z = [], 0, 0, 0
    for i in range(0, len(q), 3):
        X, Y, Z = X + q[i], Y + q[i + 1], Z + q[i + 2]
        p.append([X / 10, Y / 10, Z])
    return p


def pack(tr):
    """packs tr in place (its "p" lists as "q"); returns it"""
    for k in KINDS:
        for e in tr.get(k, ()):
            if "p" in e:
                e["q"] = pack_points(e.pop("p"))
    return tr


def unpack(tr):
    """unpacks tr in place ("q" back to "p"); returns it"""
    for k in KINDS:
        for e in tr.get(k, ()):
            if "q" in e:
                e["p"] = unpack_points(e.pop("q"))
    return tr


if __name__ == "__main__":
    for f in sys.argv[1:]:
        tr = pack(json.load(open(f)))
        json.dump(tr, open(f, "w"), separators=(",", ":"))
