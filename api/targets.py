"""The test targets.

`ra`/`dec` are the position the cache is centred on: the catalogue position moved
forward by proper motion to MID_SURVEY_EPOCH, because several targets move by
arcminutes between J2000 and the SPHEREx observations (Barnard's Star ~4.5').
`ra_cat`/`dec_cat` are the catalogue position at `epoch_cat`.

NOTE: proper motions below were checked against SIMBAD on 2026-11-14 (WISE 0855 pmdec
had the wrong sign before). Accuracy needed is only ~arcsec, far below the cutout size.
"""
import math

MID_SURVEY_EPOCH = 2026.0
DEFAULT_FOV_ARCMIN = 6.0  # cutout field of view cached per target (arcmin)

# pmra includes the cos(dec) factor (SIMBAD convention), mas/yr
_CATALOGUE = {
    "barnards-star": dict(name="Barnard's Star", ra_cat=269.45208, dec_cat=4.69336, epoch_cat=2000.0,
                          pmra=-801.551, pmdec=10362.394),
    "wise-0855-0714": dict(name="WISE 0855-0714", ra_cat=(8 + 55 / 60 + 10.831 / 3600) * 15,
                           dec_cat=-(7 + 14 / 60 + 42.53 / 3600), epoch_cat=2010.34,  # WISE epoch (MJD 55320), Luhman 2014
                           pmra=-8123.7, pmdec=673.2),
    "eps-ind-b": dict(name="Epsilon Indi B", ra_cat=331.04415, dec_cat=-56.78284, epoch_cat=2000.0,
                      pmra=3981.977, pmdec=-2466.832),
    "rw-aurigae": dict(name="RW Aurigae", ra_cat=76.95653, dec_cat=30.40144, epoch_cat=2000.0,
                       pmra=7.23, pmdec=-20.33),
    "r-draconis": dict(name="R Draconis", ra_cat=248.16761, dec_cat=66.75498, epoch_cat=2000.0,
                       pmra=-20.643, pmdec=6.149),
    # synthetic target written by scripts/make_fake_cutouts.py - not real data
    "fake_mover": dict(name="Fake mover (synthetic)", ra_cat=150.0, dec_cat=2.0, epoch_cat=2026.0,
                       pmra=0.0, pmdec=0.0, fake=True),
}


def propagate(t: dict, epoch: float = MID_SURVEY_EPOCH):
    """Catalogue position moved by proper motion to `epoch` -> (ra_deg, dec_deg)."""
    dt = epoch - t["epoch_cat"]
    dec = t["dec_cat"] + t["pmdec"] * dt / 3.6e6
    ra = t["ra_cat"] + t["pmra"] * dt / 3.6e6 / math.cos(math.radians(t["dec_cat"]))
    return ra, dec


TARGETS = {}
for _k, _t in _CATALOGUE.items():
    _ra, _dec = propagate(_t)
    TARGETS[_k] = {**_t, "ra": _ra, "dec": _dec}

REAL_TARGETS = [k for k, t in TARGETS.items() if not t.get("fake")]


def key_for(name: str) -> str:
    return name.strip().lower().replace("'", "").replace(" ", "-")


def find_by_name(name: str):
    """Return (key, target) for a known target name/key, else None."""
    k = key_for(name)
    aliases = {"eps-ind-b": "eps-ind-b", "epsilon-indi-b": "eps-ind-b", "eps-ind-ba": "eps-ind-b",
               "wise-j0855-0714": "wise-0855-0714", "wise-0855-0714": "wise-0855-0714",
               "rw-aur": "rw-aurigae", "r-dra": "r-draconis"}
    k = aliases.get(k, k)
    if k in TARGETS:
        return k, TARGETS[k]
    for key, t in TARGETS.items():
        if key_for(t["name"]) == k:
            return key, t
    return None


def find_by_coords(ra: float, dec: float, tol_deg: float = 0.05):
    """Known target whose cache centre OR catalogue position is within tol_deg, else None."""
    best = None
    for key, t in TARGETS.items():
        for tra, tdec in ((t["ra"], t["dec"]), (t["ra_cat"], t["dec_cat"])):
            d = math.hypot((ra - tra) * math.cos(math.radians(dec)), dec - tdec)
            if d <= tol_deg and (best is None or d < best[0]):
                best = (d, key, t)
    return (best[1], best[2]) if best else None


def nearest(ra: float, dec: float, keys):
    """Closest of `keys` to (ra, dec), measured to either its cache centre or its catalogue position.

    Returns (key, target, distance_arcmin) or None if keys is empty.
    """
    best = None
    for key in keys:
        t = TARGETS[key]
        for tra, tdec in ((t["ra"], t["dec"]), (t["ra_cat"], t["dec_cat"])):
            d = math.hypot((ra - tra) * math.cos(math.radians(dec)), dec - tdec) * 60.0
            if best is None or d < best[2]:
                best = (key, t, d)
    return best
