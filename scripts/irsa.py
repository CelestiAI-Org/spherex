"""IRSA helpers: SIA search for SPHEREx spectral images and cutout download.

Used only by the offline pre-caching scripts - the API never calls these.
"""
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyvo
import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ["spherex_dr1", "spherex_qr3"]  # SPHEREx spectral images: data release 1 + quick release 3

# Column names differ a little between services, so pick the first that exists.
URL_COLS = ["access_url", "download_url"]
ID_COLS = ["obs_id"]  # NOT unique: shared by the 6 detectors - file names come from access_url
TMIN_COLS = ["t_min", "mjd_obs", "mjd_avg", "time_bounds_lower"]
TMAX_COLS = ["t_max", "mjd_end", "time_bounds_upper"]


def pick(colnames, candidates):
    for c in candidates:
        if c in colnames:
            return c
    return None


def _search_one(collection, ra, dec, radius_deg, tries=60):
    """SIA search of one collection (plain HTTP, since pyvo lowercases the COLLECTION keyword).

    IRSA's SIA flaps with 502s during outages, so retry.
    """
    from astropy.table import Table
    params = {"COLLECTION": collection, "POS": f"circle {ra} {dec} {radius_deg}"}
    for attempt in range(tries):
        try:
            r = requests.get(SIA_URL, params=params, timeout=120)
            r.raise_for_status()
            return Table.read(io.BytesIO(r.content), format="votable", use_names_over_ids=True)
        except Exception as e:  # noqa: BLE001
            print(f"  SIA {collection} attempt {attempt + 1} failed: {str(e)[:70]}")
            time.sleep(4)
    raise RuntimeError(f"SIA search for {collection} kept failing")


def sia_search(ra: float, dec: float, radius_deg: float = 0.05):
    """SIA result table (astropy Table) for a position, all SPHEREx collections combined."""
    from astropy.table import vstack
    tables = [_search_one(c, ra, dec, radius_deg) for c in COLLECTIONS]
    tables = [t for t in tables if len(t)]
    return vstack(tables, metadata_conflicts="silent") if tables else _search_one(COLLECTIONS[0], ra, dec, radius_deg)


def summarise(table) -> dict:
    """Number of images, time range and the columns we use. Printed/logged by the caller."""
    cols = table.colnames
    url, ident = pick(cols, URL_COLS), pick(cols, ID_COLS)
    tmin, tmax = pick(cols, TMIN_COLS), pick(cols, TMAX_COLS)
    info = {"n_images": len(table), "all_columns": cols,
            "columns_used": {"url": url, "id": ident, "t_min": tmin, "t_max": tmax}}
    if tmin and len(table):
        t0 = np.array(table[tmin], dtype=float)
        t1 = np.array(table[tmax], dtype=float) if tmax else t0
        info["mjd_range"] = [float(np.nanmin(t0)), float(np.nanmax(t1))]
    return info


def cutout_url(access_url: str, ra: float, dec: float, fov_arcmin: float) -> str:
    sep = "&" if "?" in access_url else "?"
    return f"{access_url}{sep}center={ra:.6f},{dec:.6f}&size={fov_arcmin / 60:.6f}deg"


def download_cutout(url: str, dest: Path, retries: int = 4, drop=("EPSF",)) -> bool:
    """Download one cutout and save it without the big EPSF table (4 MB of the 4.1 MB)."""
    from astropy.io import fits
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=180)
            if r.status_code == 200 and r.content[:6] == b"SIMPLE":
                with fits.open(io.BytesIO(r.content)) as hdul:
                    keep = fits.HDUList([h for h in hdul if h.name not in drop])
                    keep.writeto(dest, overwrite=True)
                return True
            print(f"  HTTP {r.status_code} for {url}")
        except Exception as e:  # noqa: BLE001
            print(f"  error {str(e)[:80]} (attempt {attempt + 1})")
        time.sleep(2 * (attempt + 1))
    return False
