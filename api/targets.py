"""The test targets. Coordinates are J2000 degrees (SIMBAD).

NOTE: Barnard's Star is the confirmed first target. The other four are my
placeholder picks (nearby high-proper-motion stars) - edit freely.
"""

TARGETS = {
    "barnards-star":     {"name": "Barnard's Star",     "ra": 269.4521, "dec":   4.6934},
    "proxima-centauri":  {"name": "Proxima Centauri",   "ra": 217.4290, "dec": -62.6795},
    "wolf-359":          {"name": "Wolf 359",           "ra": 164.1203, "dec":   7.0147},
    "61-cygni":          {"name": "61 Cygni",           "ra": 316.7248, "dec":  38.7494},
    "kapteyns-star":     {"name": "Kapteyn's Star",     "ra":  77.9328, "dec": -45.0186},
}

DEFAULT_FOV_ARCMIN = 6.0  # cutout field of view cached per target (arcmin)


def key_for(name: str) -> str:
    return name.strip().lower().replace("'", "").replace(" ", "-")


def find_by_name(name: str):
    """Return (key, target) for a known target name/key, else None."""
    k = key_for(name)
    if k in TARGETS:
        return k, TARGETS[k]
    for key, t in TARGETS.items():
        if key_for(t["name"]) == k:
            return key, t
    return None


def find_by_coords(ra: float, dec: float, tol_deg: float = 0.05):
    """Return (key, target) for the known target within tol_deg of (ra, dec), else None."""
    import math
    best = None
    for key, t in TARGETS.items():
        d = math.hypot((ra - t["ra"]) * math.cos(math.radians(dec)), dec - t["dec"])
        if d <= tol_deg and (best is None or d < best[0]):
            best = (d, key, t)
    return (best[1], best[2]) if best else None
