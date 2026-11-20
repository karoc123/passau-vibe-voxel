"""Per-object overrides: one JSON file per OSM object, describing WHAT to build there as parameters and named parts
(scripts/parts.py), never as voxels. Each file is the whole curation of one object, so agents refining different
objects never touch the same file, and the result is rebuilt from the data every time (any map extent, any cover).

    scripts/overrides/building/<id>.json    a building outline or building:part: <id> is the OSM way id, r<id> a relation
    scripts/overrides/street/<id>.json      a highway way, by its OSM way id
    scripts/overrides/water/<id>.json       a water area (natural=water, water=*): <id> as for a building

Every file carries `osm`: what it was written against (the element's type and id, a hash of its geometry and of its
tags, the extract's timestamp). The build warns when the element's geometry changed or the element vanished
(`check`), and fails on a file that does not validate (unknown keys, bad colours or materials, a wrong id kind).

A building file (all keys optional except `osm`):
  note            free text: what was changed and why, the sources looked at
  wall, roof      {colour: "#rrggbb", material: landmarks.MAT_IDS name}; roof may also give a shape:
                  roof.shape  flat | gabled | hipped | pyramidal (the roof surface rebuilt from parameters; gabled
                  and pyramidal over the footprint's oriented box: for a rectangle; hipped: eaves all round any shape)
                  roof.eaves, roof.ridge  metres over the footprint's median ground (defaults: the current roof's 15th and
                  95th percentile); roof.ridge_dir  long | short | a bearing in degrees (gabled: the ridge's direction)
  zones, crown    facade bands along the footprint's long axis (as before in overrides.json; see landmarks.apply_zones)
  windows         {bay, width, rows: [[from, height], ...] (m over the ground), colour, depth, margin, skip_edges}:
                  real window openings on every straight outer edge (landmarks.edge_windows)
  parts           [{part: <name in parts.PARTS>, at: ..., repeat: ..., <the part's parameters>}]
  min_part_height apply only to features at least this tall
  label           {name, en, kind, height, year, rebuilt, by, building} as landmarks.LABELS
A street file:
  width, lanes, surface   OSM tags set on the way (surface: a key of SURFACES)
  sidewalk        {left, right (m), surface, kerb: bool}: paved strips beside the carriageway, a kerb line between
  trees           {side: both|left|right, spacing, offset, start, end, species, height}: young trees along it
  lamps           {side, spacing, offset, start, end, height}: street lamps along it
  piers           {spans: [m, ...], from: start|end}: a bridge way's spans as its source lists them, from the way's
                  first node (start, the default) or its last; the piers stand between them, the stations scaled to
                  the way's length (an abutment's few metres more or less), as bridge:support=pier nodes on the way
                  (voxelize.py bridge_piers: across the whole deck, its twin carriageway's too, in the river as well;
                  the way and the ways beside it get no derived piers). For a bridge OSM maps no piers on
  (left/right as the way is drawn in OSM; offset: metres from the way's centre line, default half the width + 1.5)
A water file (a lock chamber, a basin: water whose level is its own, not the river's around it):
  level           m a.s.l. of the water surface over the whole polygon (the top water voxel: round(level - base) - 1);
                  the polygon is then no part of any river body (voxelize.py: the bodies' medians are taken without it).
                  A lock chamber's level is a state (full or empty), not a structure: say which in `note`
  walls           {colour, material}: the faces of the banks 2 m or more over the water within 2 m of the polygon
                  (default concrete #a7a49d); the outline counts as a mapped wall, so grassy crests get faces too
  gates           [{way, top, sill, colour, material, walkway_colour}]: waterway=lock_gate lines drawn as walls across
                  the water, from the lower water's surface to `top` (m a.s.l.), its top voxel a walkway
                  (walkway_colour, default #b8bcc0 metal), the leaves colour/material (default #54585c metal); `sill`
                  (m a.s.l., under top): concrete from the lower water up to it (a lock head's sill in an empty
                  chamber). `osm.gates` holds each gate way's geometry hash (rebase writes it), so `check` sees one
                  redrawn. The river water by a gate's outer side (the lock's approaches) stands at the level of its
                  stretch (scripts/map.json rivers.stretches), not at its body's median ground: the DGM over an
                  approach is interpolated from the walls round it (voxelize.py)

CLI:  uv run python scripts/overrides.py check              validate every file, report stale or vanished objects
      uv run python scripts/overrides.py info KIND ID       the object's tags, place and size, and a ?focus= link
      uv run python scripts/overrides.py new KIND ID        write a skeleton file with its `osm` basis
      uv run python scripts/overrides.py rebase KIND ID     refresh the basis after checking the override still fits
                                                            (KIND: building, street or water)
"""
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE / "overrides"
KINDS = ("building", "street", "water")
SYNTH_BASE = 10 ** 15  # ids of the nodes a street override adds (trees, lamps): way id * 1000 + k over this
PIER_K0, PIER_MAX = 900, 99  # (a street override's piers: k from 900 on; trees and lamps stop short of it)
# the surfaces a street override may name (the OSM values voxelize.SURF draws)
SURFACES = ("asphalt", "paving_stones", "sett", "cobblestone", "concrete", "concrete:plates", "gravel", "fine_gravel",
            "compacted", "grass", "ground", "dirt", "unhewn_cobblestone", "paved", "wood")
ROOF_SHAPES = ("flat", "gabled", "hipped", "pyramidal")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class Invalid(Exception):
    pass


# ---------------------------------------------------------------- validation

def _num(v, where, lo=None, hi=None, integer=False):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or (integer and not isinstance(v, int)):
        raise Invalid(f"{where}: expected a {'whole ' if integer else ''}number, got {v!r}")
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise Invalid(f"{where}: {v} out of range [{lo}, {hi}]")
    return v


def _colour(v, where):
    if not isinstance(v, str) or not HEX.match(v):
        raise Invalid(f"{where}: expected a colour '#rrggbb', got {v!r}")
    return v


def _material(v, where):
    import landmarks
    if v not in landmarks.MAT_IDS:
        raise Invalid(f"{where}: unknown material {v!r} (one of {', '.join(landmarks.MAT_IDS)})")
    return v


def _keys(d, allowed, where, required=()):
    if not isinstance(d, dict):
        raise Invalid(f"{where}: expected an object, got {type(d).__name__}")
    bad = sorted(set(d) - set(allowed))
    if bad:
        raise Invalid(f"{where}: unknown key(s) {bad} (allowed: {sorted(allowed)})")
    miss = [k for k in required if k not in d]
    if miss:
        raise Invalid(f"{where}: missing {miss}")


def _style(d, where, extra=()):
    _keys(d, ("colour", "material") + tuple(extra), where)
    if "colour" in d:
        _colour(d["colour"], f"{where}.colour")
    if "material" in d:
        _material(d["material"], f"{where}.material")


def _basis(d, where, kind, otype, oid):
    _keys(d, ("type", "id", "geom", "tags", "osm_timestamp") + (("gates",) if kind == "water" else ()), where,
          required=("type", "id", "geom"))
    if d["type"] != otype or d["id"] != oid:
        raise Invalid(f"{where}: says {d['type']} {d['id']}, the file name says {otype} {oid}")
    hexes = [(k, d[k]) for k in ("geom", "tags") if k in d]
    if "gates" in d:
        if not isinstance(d["gates"], dict):
            raise Invalid(f"{where}.gates: {{way id: geometry hash}} (overrides.py rebase writes it)")
        hexes += [(f"gates.{k}", v) for k, v in d["gates"].items()]
    for k, v in hexes:
        if not (isinstance(v, str) and re.match(r"^[0-9a-f]{12}$", v)):
            raise Invalid(f"{where}.{k}: expected 12 hex digits (overrides.py new/rebase write it)")


def _building(d, where):
    _keys(d, ("osm", "note", "sources", "wall", "roof", "zones", "crown", "windows", "parts", "min_part_height",
              "label", "name"), where, required=("osm",))
    if "wall" in d:
        _style(d["wall"], f"{where}.wall")
    if "roof" in d:
        r = d["roof"]
        _style(r, f"{where}.roof", ("shape", "eaves", "ridge", "ridge_dir"))
        if "shape" in r and r["shape"] not in ROOF_SHAPES:
            raise Invalid(f"{where}.roof.shape: {r['shape']!r} is not one of {ROOF_SHAPES}")
        if ("eaves" in r or "ridge" in r or "ridge_dir" in r) and "shape" not in r:
            raise Invalid(f"{where}.roof: eaves/ridge/ridge_dir need a shape")
        for k in ("eaves", "ridge"):
            if k in r:
                _num(r[k], f"{where}.roof.{k}", 0, 150)
        if "eaves" in r and "ridge" in r and r["ridge"] < r["eaves"]:
            raise Invalid(f"{where}.roof: ridge {r['ridge']} under the eaves {r['eaves']}")
        if "ridge_dir" in r and r["ridge_dir"] not in ("long", "short"):
            _num(r["ridge_dir"], f"{where}.roof.ridge_dir (long, short or a bearing)", 0, 360)
    for k, z in enumerate(d.get("zones", [])):
        w = f"{where}.zones[{k}]"
        _keys(z, ("from", "to", "origin", "wall"), w, required=("from", "to", "wall"))
        _num(z["from"], f"{w}.from", 0, 1)
        _num(z["to"], f"{w}.to", 0, 1)
        if z.get("origin", "west") not in ("west", "east", "north", "south"):
            raise Invalid(f"{w}.origin: west, east, north or south")
        _style(z["wall"], f"{w}.wall")
    if "crown" in d:
        c = d["crown"]
        _keys(c, ("height", "colour", "material", "sign_colour", "tip"), f"{where}.crown", required=("height", "colour"))
        _num(c["height"], f"{where}.crown.height", 1, 20, integer=True)
        _colour(c["colour"], f"{where}.crown.colour")
        if "sign_colour" in c:
            _colour(c["sign_colour"], f"{where}.crown.sign_colour")
        if "material" in c:
            _material(c["material"], f"{where}.crown.material")
        if "tip" in c:
            _num(c["tip"], f"{where}.crown.tip", 0, 1)
    if "windows" in d:
        w_ = d["windows"]
        w = f"{where}.windows"
        _keys(w_, ("bay", "width", "rows", "colour", "depth", "margin", "skip_edges", "min_len"), w, required=("bay", "rows"))
        _num(w_["bay"], f"{w}.bay", 2, 20)
        _num(w_.get("width", 2), f"{w}.width", 1, 6, integer=True)
        _num(w_.get("depth", 1), f"{w}.depth", 0, 3, integer=True)
        _num(w_.get("margin", 2.5), f"{w}.margin", 0, 20)
        _num(w_.get("min_len", 6), f"{w}.min_len", 2, 200)
        if not isinstance(w_["rows"], list) or not w_["rows"]:
            raise Invalid(f"{w}.rows: a list of [from, height] (m over the ground)")
        for k, row in enumerate(w_["rows"]):
            if not (isinstance(row, list) and len(row) == 2):
                raise Invalid(f"{w}.rows[{k}]: [from, height]")
            _num(row[0], f"{w}.rows[{k}][0]", 0, 150, integer=True)
            _num(row[1], f"{w}.rows[{k}][1]", 1, 20, integer=True)
        if "colour" in w_:
            _colour(w_["colour"], f"{w}.colour")
        for k in w_.get("skip_edges", []):
            _num(k, f"{w}.skip_edges", 0, 999, integer=True)
    if "parts" in d:
        import parts
        if not isinstance(d["parts"], list):
            raise Invalid(f"{where}.parts: a list")
        for k, p in enumerate(d["parts"]):
            parts.validate(p, f"{where}.parts[{k}]", Invalid)
    if "min_part_height" in d:
        _num(d["min_part_height"], f"{where}.min_part_height", 0, 300)
    if "label" in d:
        _keys(d["label"], ("name", "en", "kind", "height", "year", "rebuilt", "by", "building", "alt", "far", "site"),
              f"{where}.label", required=("name", "kind"))
    if "sources" in d and not (isinstance(d["sources"], list) and all(isinstance(s, str) for s in d["sources"])):
        raise Invalid(f"{where}.sources: a list of strings")


def _along(d, where, extra=()):
    _keys(d, ("side", "spacing", "offset", "start", "end") + tuple(extra), where, required=("spacing",))
    if d.get("side", "both") not in ("both", "left", "right"):
        raise Invalid(f"{where}.side: both, left or right")
    _num(d["spacing"], f"{where}.spacing", 4, 200)
    for k in ("offset", "start", "end"):
        if k in d:
            _num(d[k], f"{where}.{k}", 0, 5000)


def _street(d, where):
    _keys(d, ("osm", "note", "sources", "width", "lanes", "surface", "sidewalk", "trees", "lamps", "piers"), where,
          required=("osm",))
    if "width" in d:
        _num(d["width"], f"{where}.width", 1, 40)
    if "lanes" in d:
        _num(d["lanes"], f"{where}.lanes", 1, 8, integer=True)
    if "surface" in d and d["surface"] not in SURFACES:
        raise Invalid(f"{where}.surface: {d['surface']!r} is not one of {SURFACES}")
    if "sidewalk" in d:
        s = d["sidewalk"]
        _keys(s, ("left", "right", "surface", "kerb"), f"{where}.sidewalk")
        for k in ("left", "right"):
            if k in s:
                _num(s[k], f"{where}.sidewalk.{k}", 0, 15)
        if "surface" in s and s["surface"] not in SURFACES:
            raise Invalid(f"{where}.sidewalk.surface: {s['surface']!r} is not one of {SURFACES}")
        if "kerb" in s and not isinstance(s["kerb"], bool):
            raise Invalid(f"{where}.sidewalk.kerb: true or false")
    if "trees" in d:
        _along(d["trees"], f"{where}.trees", ("species", "height"))
        if "height" in d["trees"]:
            _num(d["trees"]["height"], f"{where}.trees.height", 3, 30)
        if "species" in d["trees"] and not isinstance(d["trees"]["species"], str):
            raise Invalid(f"{where}.trees.species: a Latin name, e.g. 'Tilia cordata'")
    if "lamps" in d:
        _along(d["lamps"], f"{where}.lamps", ("height",))
        if "height" in d["lamps"]:
            _num(d["lamps"]["height"], f"{where}.lamps.height", 3, 15, integer=True)
    if "piers" in d:
        pi = d["piers"]
        _keys(pi, ("spans", "from"), f"{where}.piers", required=("spans",))
        if not isinstance(pi["spans"], list) or not 2 <= len(pi["spans"]) <= PIER_MAX + 1:
            raise Invalid(f"{where}.piers.spans: a list of 2 to {PIER_MAX + 1} span lengths (m)")
        for k, v in enumerate(pi["spans"]):
            _num(v, f"{where}.piers.spans[{k}]", 3, 500)
        if pi.get("from", "start") not in ("start", "end"):
            raise Invalid(f"{where}.piers.from: start or end")
    if "sources" in d and not (isinstance(d["sources"], list) and all(isinstance(s, str) for s in d["sources"])):
        raise Invalid(f"{where}.sources: a list of strings")


def _water(d, where):
    _keys(d, ("osm", "note", "sources", "level", "walls", "gates"), where, required=("osm", "level"))
    _num(d["level"], f"{where}.level", 250, 400)
    if "walls" in d:
        _style(d["walls"], f"{where}.walls")
    if not isinstance(d.get("gates", []), list):
        raise Invalid(f"{where}.gates: a list")
    seen = set()
    for k, gt in enumerate(d.get("gates", [])):
        w = f"{where}.gates[{k}]"
        _keys(gt, ("way", "top", "sill", "colour", "material", "walkway_colour"), w, required=("way", "top"))
        _num(gt["way"], f"{w}.way", 1, None, integer=True)
        if gt["way"] in seen:
            raise Invalid(f"{w}.way: way {gt['way']} twice")
        seen.add(gt["way"])
        _num(gt["top"], f"{w}.top", 250, 400)
        if "sill" in gt:
            _num(gt["sill"], f"{w}.sill", 250, gt["top"] - 1)
        for c in ("colour", "walkway_colour"):
            if c in gt:
                _colour(gt[c], f"{w}.{c}")
        if "material" in gt:
            _material(gt["material"], f"{w}.material")
    gb = d["osm"].get("gates")
    if gb is not None and set(gb) != {str(gt["way"]) for gt in d.get("gates", [])}:
        raise Invalid(f"{where}.osm.gates: not the gates' ways (`overrides.py rebase water <id>` writes it)")
    if "sources" in d and not (isinstance(d["sources"], list) and all(isinstance(s, str) for s in d["sources"])):
        raise Invalid(f"{where}.sources: a list of strings")


def parse_name(kind, stem):
    """(osm type, id) of a file name: building 123 / r123, street 123"""
    m = re.match(r"^(r?)([1-9][0-9]*)$", stem)
    if not m or (kind == "street" and m.group(1)):
        raise Invalid(f"{kind}/{stem}.json: the name must be the OSM way id" + (" (or r<id> for a relation)"
                                                                               if kind != "street" else ""))
    return ("relation" if m.group(1) else "way"), int(m.group(2))


def validate(kind, path, d):
    where = f"{kind}/{Path(path).name}"
    otype, oid = parse_name(kind, Path(path).stem)
    if not isinstance(d, dict) or "osm" not in d:
        raise Invalid(f"{where}: no `osm` basis (write the file with `overrides.py new {kind} {Path(path).stem}`)")
    _basis(d["osm"], f"{where}.osm", kind, otype, oid)
    dict(building=_building, street=_street, water=_water)[kind](d, where)
    return otype, oid


_ALL = {}


def load(root=None):
    """{kind: {(osm type, id): {"path", "data"}}}, every file validated; SystemExit listing every invalid one"""
    root = Path(root or ROOT)
    key = str(root)
    if key in _ALL:
        return _ALL[key]
    out, errs = {k: {} for k in KINDS}, []
    for kind in KINDS:
        for p in sorted((root / kind).glob("*.json")) if (root / kind).is_dir() else []:
            try:
                d = json.load(open(p))
            except json.JSONDecodeError as e:
                errs.append(f"{kind}/{p.name}: not JSON ({e})")
                continue
            try:
                out[kind][validate(kind, p, d)] = dict(path=p, data=d)
            except Invalid as e:
                errs.append(str(e))
    if root.is_dir():
        for p in sorted(root.iterdir()):
            if p.name not in KINDS and not p.name.startswith("."):
                errs.append(f"{p.name}: unexpected in {root} (only {', '.join(KINDS)}/)")
    if errs:
        raise SystemExit("invalid override(s) in scripts/overrides:\n  " + "\n  ".join(errs))
    _ALL[key] = out
    return out


def buildings():
    return load()["building"]


def streets():
    return load()["street"]


def waters():
    return load()["water"]


def building_for(typ, oid):
    o = buildings().get((typ, oid))
    return o["data"] if o else None


# ---------------------------------------------------------------- basis and staleness

def _short(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]


def _geom_of(e):
    if e["type"] == "way":
        return [[round(p["lat"], 7), round(p["lon"], 7)] for p in e.get("geometry") or [] if p]
    return [[m.get("role", ""), m.get("ref"), [[round(p["lat"], 7), round(p["lon"], 7)] for p in m.get("geometry") or [] if p]]
            for m in e.get("members", [])]


def basis(e, timestamp=None):
    b = dict(type=e["type"], id=e["id"], geom=_short(_geom_of(e)), tags=_short(e.get("tags", {})))
    if timestamp:
        b["osm_timestamp"] = timestamp
    return b


def check(elements, timestamp=None, quiet=False):
    """warnings (strings) for overrides whose OSM element changed or vanished; the element's kind checked too"""
    idx = {(e["type"], e["id"]): e for e in elements if e["type"] in ("way", "relation")}
    warn = []
    for kind, objs in load().items():
        for key, o in objs.items():
            e = idx.get(key)
            name = f"{kind}/{o['path'].name}"
            if e is None:
                warn.append(f"{name}: OSM {key[0]} {key[1]} is gone from the extract (vanished or merged): the override "
                            "applies to nothing")
                continue
            t = e.get("tags", {})
            if kind == "building" and not ("building" in t or "building:part" in t):
                warn.append(f"{name}: OSM {key[0]} {key[1]} is no building (tags {sorted(t)[:6]})")
            if kind == "street" and "highway" not in t:
                warn.append(f"{name}: OSM way {key[1]} is no highway (tags {sorted(t)[:6]})")
            if kind == "water":
                if not _is_water(t):
                    warn.append(f"{name}: OSM {key[0]} {key[1]} is no water area (tags {sorted(t)[:6]})")
                warn += _check_gates(name, o, idx)
            now, was = basis(e), o["data"]["osm"]
            if now["geom"] != was["geom"]:
                warn.append(f"{name}: STALE, the geometry changed since the override was written (check it still fits, "
                            f"then `overrides.py rebase {kind} {o['path'].stem}`)")
            elif "tags" in was and now["tags"] != was["tags"]:
                warn.append(f"{name}: the tags changed since the override was written (check, then rebase)")
    if warn and not quiet:
        print("overrides:\n  " + "\n  ".join(warn))
    return warn


def _is_water(t):
    return t.get("natural") == "water" or "water" in t


def _gate_basis(d, idx):
    """{way id (str): geometry hash} of the water file's gates present in idx"""
    return {str(gt["way"]): _short(_geom_of(idx[("way", gt["way"])])) for gt in d.get("gates", [])
            if ("way", gt["way"]) in idx}


def _check_gates(name, o, idx):
    """a water file's gate ways: present, waterway=lock_gate, drawn as when the file was written (osm.gates)"""
    out, was = [], o["data"]["osm"].get("gates", {})
    for gt in o["data"].get("gates", []):
        e = idx.get(("way", gt["way"]))
        if e is None:
            out.append(f"{name}: gate way {gt['way']} is gone from the extract: the gate is not drawn")
            continue
        if e.get("tags", {}).get("waterway") != "lock_gate":
            out.append(f"{name}: gate way {gt['way']} is no waterway=lock_gate (tags {sorted(e.get('tags', {}))[:6]})")
        if str(gt["way"]) not in was:
            out.append(f"{name}: gate way {gt['way']} has no basis (`overrides.py rebase water {o['path'].stem}`)")
        elif _short(_geom_of(e)) != was[str(gt["way"])]:
            out.append(f"{name}: STALE, gate way {gt['way']}'s geometry changed since the override was written (check "
                       f"it still fits, then `overrides.py rebase water {o['path'].stem}`)")
    return out


def objects():
    """the (osm type, id) of every override"""
    return {k for objs in load().values() for k in objs}


def keys_in(elements):
    """the override files (path relative to ROOT, its content hash) of the ways and relations among elements: what a
    region's build reads of scripts/overrides (region_inputs.cut_osm: of the objects near the region). (A water
    file's gate ways lie on its polygon's ends, so they are in the cut whose hash goes with this one: redrawing a gate
    in OSM rebuilds the regions that draw it)"""
    have = {(e["type"], e["id"]) for e in elements if e["type"] in ("way", "relation")}
    out = []
    for kind, objs in load().items():
        for key, o in sorted(objs.items()):
            if key in have:
                out.append((f"{kind}/{o['path'].name}", hashlib.sha256(o["path"].read_bytes()).hexdigest()))
    return sorted(out)


def tree_sha():
    """a hash of every override file (the steps after the regions: traffic.py reads the street overrides)"""
    h = hashlib.sha256()
    if ROOT.is_dir():
        for p in sorted(ROOT.rglob("*.json")):
            h.update(str(p.relative_to(ROOT)).encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


# ---------------------------------------------------------------- streets: OSM's elements patched as they are read

def _along_points(line, spec, width, sides):
    """[(side, k, x, y)] every `spacing` m along line (EPSG:25832), offset to its sides"""
    import numpy as np
    off = spec.get("offset", width / 2 + 1.5)
    a, b = spec.get("start", spec["spacing"] / 2), min(spec.get("end", line.length), line.length)
    out, k = [], 0
    for d in np.arange(a, b + 1e-6, spec["spacing"]):
        p, q = line.interpolate(d), line.interpolate(min(d + 0.5, line.length))
        if q.equals(p):
            q, p = p, line.interpolate(max(d - 0.5, 0))
        tx, ty = q.x - p.x, q.y - p.y
        n = (tx * tx + ty * ty) ** 0.5 or 1.0
        lx, ly = -ty / n, tx / n  # left of the way's direction (EPSG:25832: x east, y north)
        for side in sides:
            s = 1 if side == "left" else -1
            out.append((side, k, p.x + s * lx * off, p.y + s * ly * off))
            k += 1
    return out


def _way_line(e):
    from pyproj import Transformer
    from shapely.geometry import LineString
    import aoi
    tr = Transformer.from_crs(4326, aoi.CRS, always_xy=True)
    pts = [tr.transform(p["lon"], p["lat"]) for p in e.get("geometry") or [] if p]
    return LineString(pts) if len(pts) >= 2 else None


def street_width(tags):
    """the carriageway width voxelize.py draws a way at (its HW table's defaults, lanes x 3.1, the width tag)"""
    import ways
    return ways.way_width(tags)


def pier_stations(length, spec):
    """metres from the way's first node to each pier of a `piers` spec, its spans scaled to the way's length"""
    spans = spec["spans"] if spec.get("from", "start") == "start" else spec["spans"][::-1]
    f, acc, out = length / sum(spans), 0.0, []
    for v in spans[:-1]:
        acc += v
        out.append(acc * f)
    return out


def _piers(e, spec, back):
    """the bridge:support=pier nodes of a street override's `piers` on way e"""
    line = _way_line(e)
    if line is None:
        return []
    out = []
    for k, dist in enumerate(pier_stations(line.length, spec)):
        p = line.interpolate(dist)
        lon, lat = back.transform(p.x, p.y)
        out.append(dict(type="node", id=SYNTH_BASE + e["id"] * 1000 + PIER_K0 + k, lat=round(lat, 8),
                        lon=round(lon, 8), tags={"bridge:support": "pier", "source": "override"}))
    return out


def patch_elements(elements):
    """OSM's elements as the overrides change them, in place: a street's tags (width, lanes, surface), and the trees and
    lamps and bridge piers it adds as nodes (natural=tree, highway=street_lamp, bridge:support=pier; ids SYNTH_BASE +
    way id x 1000 + k, after the elements, by way id). Returns the elements. Only ways present are patched (a
    region's cut patches its own: it holds the whole way, so the piers' stations are the same in every cut)."""
    objs = streets()
    if not objs:
        return elements
    from pyproj import Transformer
    import aoi
    back = Transformer.from_crs(aoi.CRS, 4326, always_xy=True)
    add = []
    for e in elements:
        if e["type"] != "way" or ("way", e["id"]) not in objs:
            continue
        d = objs[("way", e["id"])]["data"]
        t = e.setdefault("tags", {})
        for k in ("width", "lanes", "surface"):
            if k in d:
                t[k] = str(d[k])
        if "piers" in d:
            add.extend(_piers(e, d["piers"], back))
        if "trees" in d or "lamps" in d:
            line = _way_line(e)
            if line is None:
                continue
            w = street_width(t)
            for what, tags0, k0 in (("trees", {"natural": "tree"}, 0), ("lamps", {"highway": "street_lamp"}, 500)):
                if what not in d:
                    continue
                spec = d[what]
                sides = ("left", "right") if spec.get("side", "both") == "both" else (spec["side"],)
                for side, k, x, y in _along_points(line, spec, w, sides):
                    if k0 + k >= PIER_K0:
                        break
                    lon, lat = back.transform(x, y)
                    tags = dict(tags0, source="override")
                    if what == "trees":
                        if "species" in spec:
                            tags["species"] = spec["species"]
                        if "height" in spec:
                            tags["height"] = str(spec["height"])
                    elif "height" in spec:
                        tags["height"] = str(spec["height"])
                    add.append(dict(type="node", id=SYNTH_BASE + e["id"] * 1000 + k0 + k, lat=round(lat, 8),
                                    lon=round(lon, 8), tags=tags))
    elements.extend(sorted(add, key=lambda n: n["id"]))
    return elements


def sidewalks(lines, note=None):
    """[(polygon, surface key or "kerb")] of the street overrides' sidewalks and kerbs, in the region's grid: lines are
    voxelize's osm.lines (id, tags, LineString)"""
    objs = streets()
    out = []
    for oid, t, line in lines:
        o = objs.get(("way", oid))
        if not o or "sidewalk" not in o["data"]:
            continue
        s = o["data"]["sidewalk"]
        w = street_width(t)
        surf = s.get("surface", "paving_stones")
        for side, sgn in (("left", 1), ("right", -1)):
            sw = s.get(side, 0)
            if sw <= 0:
                continue
            kerb = 1.0 if s.get("kerb", True) else 0.0
            # (y grows south in the grid: the left of the way is a positive offset_curve, as in EPSG:25832 mirrored)
            mid = line.offset_curve(-sgn * (w / 2 + kerb + sw / 2))
            if not mid.is_empty:
                out.append((mid.buffer(sw / 2, cap_style="flat"), surf))
            if kerb:
                kl = line.offset_curve(-sgn * (w / 2 + 0.5))
                if not kl.is_empty:
                    out.append((kl.buffer(0.71, cap_style="flat"), "kerb"))  # (0.71: unbroken on a diagonal)
    if note and out:
        note("street overrides: sidewalk and kerb strips:", len(out))
    return out


# ---------------------------------------------------------------- buildings: applied by voxelize.py

def _own(f):
    """the override written for this very feature (not one it inherits from its outline), if its height qualifies"""
    o = building_for(f["typ"], f["id"])
    if o and (f["maxh"] or 0) >= o.get("min_part_height", -1):
        return o
    return None


def roof_shapes(feats, top, dtm, gx, gy, pitched, R0, C0, note):
    """roof.shape: the roof surface of the building's cells rebuilt from parameters (top: height over the terrain per
    cell, written in place; gx, gy: the roof plane's rise per metre east and south, for the viewer's shading; pitched:
    the cells of pitched roofs). Heights are over the footprint's median terrain, so a roof over a sloping street is
    level. Before the roof's voxel is rounded (voxelize.py: topi)."""
    import numpy as np
    from parts import frame
    for f in feats:
        o = _own(f)
        if not o or "shape" not in o.get("roof", {}):
            continue
        r = o["roof"]
        rr, cc = f["rr"], f["cc"]
        if len(rr) < 4:
            continue
        ground = float(np.median(dtm[rr, cc]))
        now = top[rr, cc] + dtm[rr, cc] - ground
        eaves = r.get("eaves", float(np.percentile(now, 15)))
        ridge = max(r.get("ridge", float(np.percentile(now, 95))), eaves)
        u, v, hu, hv, ax, perp, _ = frame(rr, cc, R0, C0, r.get("ridge_dir", "long"))
        k = (ridge - eaves) / hv
        fu, fv = hu - np.abs(u), hv - np.abs(v)
        sv, su = np.sign(v), np.sign(u)
        # the slope's direction per cell: away from the ridge across (perp) or along (ax), as the shape's planes run
        if r["shape"] == "flat":
            h, across = np.full(len(rr), eaves), None
        elif r["shape"] == "gabled":
            h, across = eaves + k * fv, np.ones(len(rr), bool)
        elif r["shape"] == "hipped":
            # eaves all round, any footprint (an L, a T): rising with the distance from the outline, capped at the
            # ridge; the slope from the narrowest part's half-width
            from scipy import ndimage
            r0, c0 = rr.min() - 1, cc.min() - 1
            fp = np.zeros((rr.max() - r0 + 2, cc.max() - c0 + 2), bool)
            fp[rr - r0, cc - c0] = True
            dist, (ir, ic) = ndimage.distance_transform_edt(fp, return_indices=True)
            d = dist[rr - r0, cc - c0] - 0.5
            kh = (ridge - eaves) / max(float(np.percentile(d, 90)), 0.5)
            h = np.minimum(eaves + kh * d, ridge)
            oy, ox = (rr - r0) - ir[rr - r0, cc - c0], (cc - c0) - ic[rr - r0, cc - c0]
            n_ = np.maximum(np.hypot(ox, oy), 1e-6)
            top[rr, cc] = h + ground - dtm[rr, cc]
            flat_ = h >= ridge - 1e-6
            gx[rr, cc] = np.where(flat_, np.nan, kh * ox / n_)
            gy[rr, cc] = np.where(flat_, np.nan, kh * oy / n_)
            pitched[rr, cc] = kh >= 0.3
            note(f"override roof: {f['typ']} {f['id']}: hipped, eaves {eaves:.1f} m, ridge {ridge:.1f} m, {len(rr)} cells")
            continue
        else:  # pyramidal
            ku = (ridge - eaves) / hu
            h = eaves + np.minimum(k * fv, ku * fu)
            across = k * fv <= ku * fu
        top[rr, cc] = h + ground - dtm[rr, cc]
        if across is None:
            gx[rr, cc], gy[rr, cc] = 0.0, 0.0
            pitched[rr, cc] = False
        else:
            kk = np.where(across, k, (ridge - eaves) / hu if r["shape"] == "pyramidal" else k)
            dx = np.where(across, -sv * perp[0], -su * ax[0]) * kk
            dy = np.where(across, -sv * perp[1], -su * ax[1]) * kk
            ridge_cell = np.where(across, np.abs(v) < 0.5, np.abs(u) < 0.5)
            gx[rr, cc] = np.where(ridge_cell, np.nan, dx)
            gy[rr, cc] = np.where(ridge_cell, np.nan, dy)
            pitched[rr, cc] = k >= 0.3
        note(f"override roof: {f['typ']} {f['id']}: {r['shape']}, eaves {eaves:.1f} m, ridge {ridge:.1f} m, "
             f"{len(rr)} cells")


def apply_details(vol, g, feats, pal, note):
    """windows and parts of the building overrides, on the finished building voxels (after landmarks.apply_zones)"""
    import landmarks
    from aoi import C0, R0, to_grid
    for f in feats:
        n_w = n_p = 0
        o = _own(f)
        if not o or not ("windows" in o or "parts" in o) or len(f["rr"]) == 0:
            continue
        if "windows" in o and f["geom"].geom_type == "Polygon":
            w = o["windows"]
            win = pal(w.get("colour", "#3a4644"), landmarks.MAT_IDS["window"])
            n_w += landmarks.edge_windows(vol, g, f["geom"], win, [tuple(r) for r in w["rows"]], w["bay"],
                                          w=w.get("width", 2), margin=w.get("margin", 2.5), min_len=w.get("min_len", 6),
                                          depth=w.get("depth", 1), skip=set(w.get("skip_edges", [])))
        if "parts" in o:
            import parts
            # (an outline drawn through its parts has no wall of its own: its largest part's)
            src = f if "wall" in f else max([p for p in feats if p.get("parent") is f and "wall" in p] or [None],
                                            key=lambda p: len(p["rr"]) if p else 0)
            wall, roof = (src["wall"], src["roof"]) if src else (pal("#d8d0c0", landmarks.MAT_IDS["wall"]),
                                                                  pal("#7d7f84", landmarks.MAT_IDS["roof"]))
            ctx = parts.Ctx(vol, g, pal, f["rr"], f["cc"], wall, roof, R0, C0, landmarks.MAT_IDS)
            for p in o["parts"]:
                n_p += parts.build(ctx, p, to_grid)
        note(f"override details: {f['typ']} {f['id']}: windows {n_w}, part voxels {n_p}")


# ---------------------------------------------------------------- water: applied by voxelize.py

WALL_STYLE = ("#a7a49d", "concrete")  # a water override's wall faces (voxelize.C["deck"]: the lock's crests in the ortho)
GATE_STYLE = ("#54585c", "metal")
WALKWAY = "#b8bcc0"


def water_levels(areas, cells_of, base):
    """[(oid, rows, cols, g, walls style, polygon)] of the water overrides among areas (voxelize's osm.areas, the
    region's grid): the cells whose centres lie in the polygon and the ground index g of its level (the top water voxel
    is g - 1, as voxelize.py's river levels)"""
    import math
    objs = waters()
    out = []
    for oid, typ, t, geom in areas:
        o = objs.get((typ, oid))
        if not o:
            continue
        d = o["data"]
        rr, cc = cells_of(geom, fallback=False)
        w = d.get("walls", {})
        out.append((oid, rr, cc, int(math.floor(d["level"] - base + 0.5)),
                    (w.get("colour", WALL_STYLE[0]), w.get("material", WALL_STYLE[1])), geom))
    return out


def gate_lines(lines):
    """the water overrides' gate lines among lines (voxelize's osm.lines, the region's grid): [(gate, line)]"""
    byid = {oid: line for oid, t, line in lines}
    return [(gt, byid[gt["way"]]) for o in waters().values() for gt in o["data"].get("gates", []) if gt["way"] in byid]


def lock_gates(vol, g, water, lines, pal, mats, cells_of, base, note):
    """the water overrides' gates (waterway=lock_gate lines, voxelize's osm.lines) into vol: on each water cell of the
    line's band (all cells touched within 0.5 m: closed, so the chamber stays apart from the water beside it) a wall
    from the lower water's surface voxel (the lowest water within 3.5 m) to `top`, its top voxel the walkway, concrete
    under `sill`; on a dry cell (the walls' crests at its ends) the leaves and walkway over the ground only"""
    import numpy as np
    byid = {oid: line for oid, t, line in lines}
    H = vol.shape[0]
    n_g = n_v = 0
    for o in waters().values():
        d = o["data"]
        wall = pal(*_style_of(d.get("walls", {}), WALL_STYLE, mats))
        for gt in d.get("gates", []):
            line = byid.get(gt["way"])
            if line is None:
                continue
            rr, cc = cells_of(line.buffer(0.5), all_touched=True)
            if len(rr) == 0:
                continue
            nr, nc = cells_of(line.buffer(3.5), all_touched=True)
            wet = water[nr, nc]
            if not wet.any():
                continue
            z_lo = int(g[nr, nc][wet].min()) - 1
            z_top = min(int(round(gt["top"] - base)), H)
            z_sill = max(int(round(gt["sill"] - base)), z_lo) if "sill" in gt else z_lo
            leaf = pal(*_style_of(gt, GATE_STYLE, mats))
            walk = pal(gt.get("walkway_colour", WALKWAY), mats["metal"])
            for r, c in zip(rr, cc):
                z0 = z_lo if water[r, c] else int(g[r, c])
                for zz in range(max(z0, 0), z_top):
                    vol[zz, r, c] = walk if zz == z_top - 1 else (wall if zz < z_sill else leaf)
                    n_v += 1
            n_g += 1
            note(f"lock gate: way {gt['way']}: {len(rr)} cells, from {z_lo + base} m (sill {z_sill + base} m) to "
                 f"{z_top + base} m")
    if n_g:
        note("lock gates (water overrides):", n_g, "gates,", n_v, "voxels")


def _style_of(d, default, mats):
    return d.get("colour", default[0]), mats[d.get("material", default[1])]


# ---------------------------------------------------------------- CLI

def _osm():
    import aoi
    data = json.load(open(f"{aoi.RAW}/osm.json"))
    return data, {(e["type"], e["id"]): e for e in data["elements"] if e["type"] in ("way", "relation")}


def _target(kind, ident):
    if kind not in KINDS:
        raise SystemExit(f"kind must be one of {KINDS}")
    otype, oid = parse_name(kind, str(ident).removeprefix("w"))
    return otype, oid, ROOT / kind / f"{'r' if otype == 'relation' else ''}{oid}.json"


def info(kind, ident):
    import aoi
    from pyproj import Transformer
    otype, oid, path = _target(kind, ident)
    data, idx = _osm()
    e = idx.get((otype, oid))
    if e is None:
        raise SystemExit(f"OSM {otype} {oid} is not in data/raw/osm.json")
    tr = Transformer.from_crs(4326, aoi.CRS, always_xy=True)
    pts = [p for p in (e.get("geometry") or []) if p] or \
        [p for m in e.get("members", []) for p in (m.get("geometry") or []) if p and m.get("role") != "inner"]
    xs, ys = zip(*(tr.transform(p["lon"], p["lat"]) for p in pts))
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    c0, r0 = aoi.to_grid(x0, y1)
    c1, r1 = aoi.to_grid(x1, y0)
    print(json.dumps(dict(
        osm=f"{otype}/{oid}", tags=e.get("tags", {}),
        epsg25832=dict(x=[round(x0, 1), round(x1, 1)], y=[round(y0, 1), round(y1, 1)],
                       centre=[round((x0 + x1) / 2, 1), round((y0 + y1) / 2, 1)]),
        map_cells=dict(col=[float(c0), float(c1)], row=[float(r0), float(r1)]),
        size_m=[round(x1 - x0, 1), round(y1 - y0, 1)],
        focus=f"?focus={'bld' if kind == 'building' else 'street'}:{path.stem}" if kind != "water" else None,
        override=str(path.relative_to(HERE.parent)) if path.exists() else None,
        extract=data.get("osm3s", {}).get("timestamp_osm_base")), indent=1, ensure_ascii=False))


def new(kind, ident):
    otype, oid, path = _target(kind, ident)
    data, idx = _osm()
    e = idx.get((otype, oid))
    if e is None:
        raise SystemExit(f"OSM {otype} {oid} is not in data/raw/osm.json")
    t = e.get("tags", {})
    if kind == "building" and not ("building" in t or "building:part" in t):
        raise SystemExit(f"OSM {otype} {oid} is no building: {t}")
    if kind == "street" and "highway" not in t:
        raise SystemExit(f"OSM way {oid} is no highway: {t}")
    if kind == "water" and not _is_water(t):
        raise SystemExit(f"OSM {otype} {oid} is no water area: {t}")
    if path.exists():
        raise SystemExit(f"{path} exists (edit it; `rebase` refreshes its basis)")
    path.parent.mkdir(parents=True, exist_ok=True)
    d = dict(osm=basis(e, data.get("osm3s", {}).get("timestamp_osm_base")), note=f"{t.get('name', '')}".strip())
    path.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print(path)


def rebase(kind, ident):
    otype, oid, path = _target(kind, ident)
    data, idx = _osm()
    e = idx.get((otype, oid))
    if e is None:
        raise SystemExit(f"OSM {otype} {oid} is not in data/raw/osm.json: delete {path} or move it to the new id")
    d = json.load(open(path))
    d["osm"] = basis(e, data.get("osm3s", {}).get("timestamp_osm_base"))
    if kind == "water" and d.get("gates"):
        miss = [gt["way"] for gt in d["gates"] if ("way", gt["way"]) not in idx]
        if miss:
            raise SystemExit(f"gate way(s) {miss} not in data/raw/osm.json: fix `gates` in {path} first")
        d["osm"]["gates"] = _gate_basis(d, idx)
    path.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print(path)


def main(argv):
    sys.path.insert(0, str(HERE))
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd = argv[0]
    if cmd == "check":
        n = sum(len(v) for v in load().values())
        data, _ = _osm()
        warn = check(data["elements"], quiet=True)
        print(f"{n} override(s) valid" + (":" if warn else ", none stale"))
        for w in warn:
            print("  " + w)
    elif cmd in ("info", "new", "rebase") and len(argv) == 3:
        dict(info=info, new=new, rebase=rebase)[cmd](argv[1], argv[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
