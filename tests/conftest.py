"""Builds a small fake cache (synthetic star moving across 3 visits) so tests run offline."""
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_TMP = Path(tempfile.mkdtemp(prefix="spherex_test_cache_"))
os.environ["SPHEREX_CACHE_DIR"] = str(_TMP)  # must be set before importing api.*

from api.targets import TARGETS  # noqa: E402
RA, DEC = TARGETS["barnards-star"]["ra"], TARGETS["barnards-star"]["dec"]
PIX = 6.2 / 3600  # SPHEREx pixel ~6.2 arcsec


def make_fake_cache(cache: Path, key="barnards-star", visits=(60000.0, 60180.0, 60360.0), fov=6.0):
    (cache / key / "cutouts").mkdir(parents=True, exist_ok=True)
    n = int(fov * 60 / 6.2) + 10
    rows = []
    rng = np.random.default_rng(0)
    for v, mjd0 in enumerate(visits):
        for k in range(2):  # 2 exposures per visit
            w = WCS(naxis=2)
            w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
            w.wcs.crval = [RA, DEC]
            w.wcs.crpix = [n / 2, n / 2]
            w.wcs.cdelt = [-PIX, PIX]
            img = rng.normal(0, 1, (n, n)) + 100.0
            y, x = np.mgrid[:n, :n]
            sx = n / 2 + 6 * v  # the "star" moves 6 px per visit
            img += 200 * np.exp(-((x - sx) ** 2 + (y - n / 2) ** 2) / 4)
            hdr = w.to_header()
            hdr["MJD-AVG"] = mjd0 + 0.1 * k
            hdr["DETECTOR"] = 1 + k
            name = f"fake_{v}_{k}.fits"
            fits.HDUList([fits.PrimaryHDU(),
                          fits.ImageHDU(img, hdr, name="IMAGE"),
                          fits.ImageHDU(np.zeros((n, n), dtype=np.int32), name="FLAGS"),
                          fits.ImageHDU(np.full((n, n), 100.0), name="ZODI")]).writeto(cache / key / "cutouts" / name, overwrite=True)
            rows.append({"file": name, "mjd": mjd0 + 0.1 * k, "detector": 1 + k})
    (cache / key / "index.json").write_text(json.dumps({"fov_arcmin": fov, "cutouts": rows}))


make_fake_cache(_TMP)


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient
    from api.main import app
    return TestClient(app)
