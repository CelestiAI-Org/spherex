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
os.environ["SPHEREX_CACHE_DIR"] = str(_TMP)
os.environ["SPHEREX_CACHE_LARGE_DIR"] = str(_TMP / "no_large_cache")  # never pick up the real cache_large/  # must be set before importing api.*

from api.targets import TARGETS, mjd_to_year, propagate  # noqa: E402
sys.path.insert(0, str(ROOT / "scripts"))
import make_fake_cutouts  # noqa: E402

RA, DEC = TARGETS["barnards-star"]["ra"], TARGETS["barnards-star"]["dec"]
PIX = 6.2 / 3600  # SPHEREx pixel ~6.2 arcsec
STAR_SUM = 5000.0


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
            # the "target": a Gaussian star (sigma 1.1 px, summed counts = STAR_SUM) at the target's
            # proper-motion-propagated position for THIS exposure's time
            mjd_i = mjd0 + 0.1 * k
            sra, sdec = propagate(TARGETS[key], mjd_to_year(mjd_i))
            tx, ty = (float(v) for v in w.all_world2pix(sra, sdec, 0))
            img += STAR_SUM / (2 * np.pi * 1.1 ** 2) * np.exp(-((x - tx) ** 2 + (y - ty) ** 2) / (2 * 1.1 ** 2))
            hdr = w.to_header()
            hdr["MJD-AVG"] = mjd0 + 0.1 * k
            hdr["DETECTOR"] = 1 + k
            wkeys, wave_hdu = make_fake_cutouts.wave_wcs(1.0 + 0.4 * k)  # detector 1: ~1.0 um (band 12), detector 2: ~1.4 um (band 27)
            hdr.update(wkeys)
            name = f"fake_{v}_{k}.fits"
            fits.HDUList([fits.PrimaryHDU(),
                          fits.ImageHDU(img, hdr, name="IMAGE"),
                          fits.ImageHDU(np.zeros((n, n), dtype=np.int32), name="FLAGS"),
                          fits.ImageHDU(np.full((n, n), 100.0), name="ZODI"),
                          fits.ImageHDU(np.full((n, n), 4.0, dtype=np.float32), name="VARIANCE"), wave_hdu]).writeto(cache / key / "cutouts" / name, overwrite=True)
            rows.append({"file": name, "mjd": mjd0 + 0.1 * k, "detector": 1 + k})
    (cache / key / "index.json").write_text(json.dumps({"fov_arcmin": fov, "cutouts": rows}))


make_fake_cache(_TMP)


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient
    from api.main import app
    return TestClient(app)
