"""The AOI's known trees: OSM natural=tree nodes (species, genus, leaf_type, height and circumference where tagged).

Every tree gets a stable id, "osm:<node id>". A municipal tree register, if Passau publishes one, would be merged here
(a second source in load(), matched to the OSM nodes by distance).
"""
from aoi import D, W


def _num(v):
    try:
        return float(str(v).replace(",", ".").split()[0])
    except (ValueError, IndexError, TypeError):
        return None


def load(osm_trees):
    """osm_trees: [(oid, tags, Point(col, row))] from voxelize's OSM reader. Returns a list of dicts with grid x, y."""
    out = []
    for oid, tg, p in osm_trees:
        if not (0 <= p.x < W and 0 <= p.y < D):
            continue
        out.append(dict(id=f"osm:{oid}", src="osm", x=float(p.x), y=float(p.y), species=tg.get("species") or tg.get("genus"),
                        trunk_cm=_num(tg.get("circumference")) and _num(tg.get("circumference")) * 100,
                        height=_num(tg.get("height")), leaf_type=tg.get("leaf_type"), osm=oid))
    return out


CONIFER = ("Pinus", "Picea", "Abies", "Taxus", "Thuja", "Larix", "Pseudotsuga", "Juniperus", "Chamaecyparis", "Metasequoia")


def is_conifer(t):
    sp = t.get("species") or ""
    return sp.startswith(CONIFER) or t.get("leaf_type") == "needleleaved"
