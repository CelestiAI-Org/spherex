"""Load cached SPHEREx cutouts as `science.types.Cutout` objects.

Usage (e.g. in a notebook, from the repo root):

    from api.load_cache import load_cutouts
    cutouts = load_cutouts("barnards-star")
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from astropy import log as astropy_log
from astropy.io import fits
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # so `science` imports work from anywhere
    sys.path.insert(0, str(ROOT))

from api.targets import TARGETS, mjd_to_year, propagate  # noqa: E402
from science.types import Cutout  # noqa: E402

# SPHEREx headers carry SIP coefficients without "-SIP" in the spectral WCS, which makes astropy log a long INFO per file.
astropy_log.setLevel("WARNING")

# FLAGS is a bit field (bit names are in the FLAGS header: MSKNnnnn). Bad = every bit except
# 12 FULLSAMPLE (info only) and 21 SOURCE (pixel belongs to a real source - we want those!).
# Use as:  good = (cutout.flags & BAD_PIXEL_MASK) == 0
BAD_PIXEL_MASK = sum(1 << b for b in (0, 1, 2, 6, 7, 9, 10, 11, 14, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28))

CACHE_DIR = Path(os.environ.get("SPHEREX_CACHE_DIR", ROOT / "cache"))


def target_dir(target_key: str) -> Path:
    return CACHE_DIR / target_key


def load_index(target_key: str) -> list[dict]:
    """The list of cached cutouts (file, mjd, detector, ...) for a target."""
    path = target_dir(target_key) / "index.json"
    if not path.exists():
        return []
    return json.loads(path.read_text())["cutouts"]


def wavelength_at(hdul, x: float, y: float) -> float | None:
    """Central wavelength (um) at pixel (x, y) from the WCS-WAVE extension, or None if there is none.

    The spectral WCS is an alternate WCS (key "W") of the IMAGE header; pixel_to_world gives
    (wavelength, bandwidth). (x, y) is clipped to the image so an off-image target still gets the
    wavelength of the nearest edge (it varies by only ~0.03 um across a cutout).
    """
    try:
        if "WCS-WAVE" not in hdul:
            return None
        ny, nx = hdul["IMAGE"].data.shape
        wave = WCS(hdul["IMAGE"].header, hdul, key="W").pixel_to_world(
            float(np.clip(x, 0, nx - 1)), float(np.clip(y, 0, ny - 1)))[0]
        value = float(getattr(wave, "value", wave))
        return value if np.isfinite(value) else None
    except Exception:  # noqa: BLE001  (a cutout without a usable spectral WCS just has no wavelength)
        return None


def load_cutout(path: Path, mjd: float | None = None, detector: int | None = None,
                target: dict | None = None) -> Cutout:
    """Load one cached cutout. `target` (an api.targets entry) says where to read the wavelength:
    the target's epoch-propagated position; without it the image centre is used."""
    with fits.open(path) as hdul:
        image = np.array(hdul["IMAGE"].data, dtype=float)
        if "ZODI" in hdul:  # subtract the zodiacal-light background
            image = image - np.array(hdul["ZODI"].data, dtype=float)
        flags = np.array(hdul["FLAGS"].data) if "FLAGS" in hdul else np.zeros(image.shape, dtype=int)
        wcs = WCS(hdul["IMAGE"].header)
        hdr = hdul["IMAGE"].header
        if mjd is None:
            mjd = float(hdr.get("MJD-AVG", hdr.get("MJD_AVG", np.nan)))
        if detector is None:
            detector = int(hdr.get("DETECTOR", 0))
        ny, nx = image.shape
        x, y = nx / 2, ny / 2
        if target is not None:
            ra, dec = propagate(target, mjd_to_year(mjd))
            x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
        wavelength = wavelength_at(hdul, x, y)
    return Cutout(image=image, flags=flags, wcs=wcs, mjd=mjd, detector=detector, wavelength_um=wavelength)


def load_cutouts(target_key: str) -> list[Cutout]:
    """All cached cutouts for a target, sorted by observation time. [] if nothing cached."""
    out = []
    target = TARGETS.get(target_key)
    for row in load_index(target_key):
        path = target_dir(target_key) / "cutouts" / row["file"]
        if path.exists():
            out.append(load_cutout(path, row.get("mjd"), row.get("detector"), target))
    out.sort(key=lambda c: c.mjd)
    return out
