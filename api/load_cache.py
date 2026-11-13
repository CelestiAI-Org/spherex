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
from astropy.io import fits
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # so `science` imports work from anywhere
    sys.path.insert(0, str(ROOT))

from science.types import Cutout  # noqa: E402

CACHE_DIR = Path(os.environ.get("SPHEREX_CACHE_DIR", ROOT / "cache"))


def target_dir(target_key: str) -> Path:
    return CACHE_DIR / target_key


def load_index(target_key: str) -> list[dict]:
    """The list of cached cutouts (file, mjd, detector, ...) for a target."""
    path = target_dir(target_key) / "index.json"
    if not path.exists():
        return []
    return json.loads(path.read_text())["cutouts"]


def load_cutout(path: Path, mjd: float | None = None, detector: int | None = None) -> Cutout:
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
    return Cutout(image=image, flags=flags, wcs=wcs, mjd=mjd, detector=detector)


def load_cutouts(target_key: str) -> list[Cutout]:
    """All cached cutouts for a target, sorted by observation time. [] if nothing cached."""
    out = []
    for row in load_index(target_key):
        path = target_dir(target_key) / "cutouts" / row["file"]
        if path.exists():
            out.append(load_cutout(path, row.get("mjd"), row.get("detector")))
    out.sort(key=lambda c: c.mjd)
    return out
