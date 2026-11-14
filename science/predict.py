"""Predicted sky position of a moving star: proper motion + parallax.

Used for the "predicted position" marker. Inputs are the catalogue fields in api/targets.py
(ra_cat, dec_cat [deg] at epoch_cat [Julian year], pmra [mas/yr, includes cos(dec)], pmdec [mas/yr]).
"""
import math

import astropy.units as u
from astropy.coordinates import SkyCoord, get_body_barycentric
from astropy.time import Time

# Parallax in mas. api/targets.py has no parallax field yet, so it lives here.
# Barnard's Star: Gaia DR3 value typed from memory - verify with SIMBAD (plx_value) before relying on it.
# Only Barnard's Star is filled in; for the others the parallax shift is < 0.5 arcsec (~0.1 pixel) anyway.
PARALLAX_MAS = {"barnards-star": 546.976}


def predicted_radec(target: dict, mjd: float, parallax_mas: float | None = None):
    """(ra_deg, dec_deg) of the star at time `mjd`, seen from Earth.

    parallax_mas=None -> use `target["plx"]` if present, else 0 (proper motion only).
    """
    jyear = Time(mjd, format="mjd").jyear
    dt = jyear - target["epoch_cat"]
    dec = target["dec_cat"] + target["pmdec"] * dt / 3.6e6
    ra = target["ra_cat"] + target["pmra"] * dt / 3.6e6 / math.cos(math.radians(target["dec_cat"]))
    plx = target.get("plx", 0.0) if parallax_mas is None else parallax_mas
    if plx:
        # Earth barycentric position (ICRS, AU). SPHEREx orbits Earth, so the offset is negligible.
        x, y, z = get_body_barycentric("earth", Time(mjd, format="mjd")).xyz.to_value(u.AU)
        a, d = math.radians(ra), math.radians(dec)
        p = plx / 1000 / 3600  # parallax in degrees
        ra += p * (x * math.sin(a) - y * math.cos(a)) / math.cos(d)
        dec += p * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d) - z * math.cos(d))
    return ra, dec


def predicted_pixel(target: dict, mjd: float, wcs, parallax_mas: float | None = None):
    """(x, y) pixel position (0-based, x = column, y = row) of the star in an image with this WCS."""
    ra, dec = predicted_radec(target, mjd, parallax_mas)
    x, y = wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
    return float(x), float(y)
