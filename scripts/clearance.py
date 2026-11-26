"""The classes of what web/tools/life-phys-scan.mjs --dump found on the carriageways:
per class the metres, stretches and roads, and the longest stretches with their OSM ways. Reads the dump, the data it
was scanned on (traffic.json, meta.json) and data/ground.npz, surface.npz, raw/osm.json; nothing written.

  uv run python scripts/clearance.py DUMP [--data DIR] [--spots N]   (DIR: the scanned web/public/data, default that)

Classes: step across / along (the surface 0.6 m or more off across the car's footprint, or a metre on; capped or not:
the column's ground run has a cap; steep: the path climbs more than 8 % over 16 m), body (solid less than 1.8 m over the
surface; "in a wall": no surface under the path at all) by what the solid is (the foliage tile's leaves, a trunk, a
building's wall over a building's cell, a lamp or a pole, a parked car, a deck, stone or concrete), hole (the surface
1.5 m or more under the path: near a bridge's deck, within 12 m of the road's end, elsewhere), and any of them on a way
mapped underground (ways.underground: tunnel, building passage, culvert, covered, indoor, layer or level < 0)."""
import collections
import json
import sys

import numpy as np

import trafficpack
from constants import M_CAR, M_CLASSIC, M_LAMP, M_LEAF, M_METAL, M_TENEMENT, M_WALL, M_WINDOW, M_WOOD, WALL_MATS
from ways import underground

WALLS = set(WALL_MATS)


def grade(p, x, z):
    """the path's climb per metre over ~16 m round (x, z)"""
    k = int(np.hypot(p[:, 0] - x, p[:, 1] - z).argmin())
    a, c = k, k
    while a > 0 and np.hypot(*(p[k, :2] - p[a, :2])) < 8:
        a -= 1
    while c < len(p) - 1 and np.hypot(*(p[c, :2] - p[k, :2])) < 8:
        c += 1
    return abs(p[c, 2] - p[a, 2]) / max(np.hypot(*(p[c, :2] - p[a, :2])), 1)


def classify(h, road, tags, pal, bld, deck):
    t = tags.get(road["w"], {})
    r, c = int(h["z"]), int(h["x"])
    if underground(t):
        return "tunnel / passage / covered (mapped)"
    if h["k"] == "hole":
        if np.isfinite(deck[r, c]) or t.get("bridge"):
            return "hole: at a bridge's deck"
        p = road["p"]
        end = min(np.hypot(h["x"] - p[0][0], h["z"] - p[0][1]), np.hypot(h["x"] - p[-1][0], h["z"] - p[-1][1]))
        return "hole: within 12 m of a junction" if end < 12 else "hole: path over a drop"
    if h["k"] == "step":
        steep = "steep" if grade(np.array(road["p"], float), h["x"], h["z"]) > 0.08 else "level"
        return f"step {'across' if h['across'] else 'along'} ({'capped' if h['cap'] else 'uncapped'}, {steep})"
    pre = "in a wall: " if h["s"] is None else "body: "
    if "mat" not in h:
        return pre + "?"
    m = pal[h["mat"]][3]
    if h["fol"] and m == M_LEAF:
        return pre + "leaves"
    if m == M_WOOD:
        return pre + "trunk / branch"
    if m in (M_WALL, M_CLASSIC, M_WINDOW, M_TENEMENT) or (bld[r, c] > 0 and m in WALLS):
        return pre + "building"
    if m in (M_LAMP, M_METAL):
        return pre + "lamp / pole / fence"
    if m == M_CAR:
        return pre + "parked car"
    if np.isfinite(deck[r, c]):
        return pre + "deck"
    return pre + ("stone / concrete (retaining wall, kerb)" if m in (0, 13) else f"material {m}")


def main(argv):
    dump = argv[0]
    pub = argv[argv.index("--data") + 1] if "--data" in argv else "web/public/data"
    nsp = int(argv[argv.index("--spots") + 1]) if "--spots" in argv else 30
    pal = json.load(open(f"{pub}/meta.json"))["palette"]
    roads = trafficpack.unpack(json.load(open(f"{pub}/traffic.json")))["roads"]
    bld = np.load("data/ground.npz")["b"]
    deck = np.load("data/surface.npz")["deck"]
    ways = {r["w"] for r in roads}
    tags = {e["id"]: e.get("tags", {}) for e in json.load(open("data/raw/osm.json"))["elements"]
            if e["type"] == "way" and e["id"] in ways}
    hits = [json.loads(line) for line in open(dump)]
    st = []  # stretches: one road's lane, one class, points within 4 m
    for h in hits:
        h["c"] = classify(h, roads[h["i"]], tags, pal, bld, deck)
        s = st[-1] if st else None
        if s and (s["i"], s["lane"], s["c"]) == (h["i"], h["lane"], h["c"]) and abs(s["x"] - h["x"]) + abs(s["z"] - h["z"]) < 4:
            s["n"] += 1
            s["x"], s["z"] = h["x"], h["z"]
        else:
            st.append(dict(i=h["i"], lane=h["lane"], c=h["c"], n=1, x=h["x"], z=h["z"], at=(h["x"], h["z"], h["y"])))
    m = collections.Counter(h["c"] for h in hits)
    ns = collections.Counter(s["c"] for s in st)
    nr = collections.defaultdict(set)
    for h in hits:
        nr[h["c"]].add(h["i"])
    print(f"{dump}: {len(hits)} m flagged\n\n| class | m | stretches | roads |\n|---|---|---|---|")
    for c, v in m.most_common():
        print(f"| {c} | {v} | {ns[c]} | {len(nr[c])} |")
    print("\nlongest stretches:")
    for s in sorted(st, key=lambda s: -s["n"])[:nsp]:
        r = roads[s["i"]]
        t = tags.get(r["w"], {})
        print(f"  road {s['i']} lane {s['lane']} (way {r['w']}, {t.get('highway')} {t.get('name', '')!r}): {s['n']} m "
              f"{s['c']} from {s['at']}")


if __name__ == "__main__":
    main(sys.argv[1:])
