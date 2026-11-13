"""IRSA helpers: SIA search for SPHEREx spectral images and cutout download.

Used only by the offline pre-caching scripts - the API never calls these.
"""
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
COLLECTION = "spherex_qr"  # SPHEREx quick-release spectral images

# Column names differ a little between services, so pick the first that exists.
URL_COLS = ["access_url", "download_url"]
ID_COLS = ["obs_id", "obsid", "obs_publisher_did", "file_name"]
TMIN_COLS = ["t_min", "mjd_obs", "mjd_avg", "time_bounds_lower"]
TMAX_COLS = ["t_max", "mjd_end", "time_bounds_upper"]


def pick(colnames, candidates):
    for c in candidates:
        if c in colnames:
            return c
    return None


def sia_search(ra: float, dec: float, radius_deg: float = 0.05):
    """Return the SIA result table (astropy Table) for a position."""
    svc = pyvo.dal.SIAService(SIA_URL)
    res = svc.search(pos=(ra, dec), size=radius_deg * 2, format="all", COLLECTION=COLLECTION)
    return res.to_table()


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


def download_cutout(url: str, dest: Path, retries: int = 3) -> bool:
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 200 and r.content[:6] == b"SIMPLE":
                dest.write_bytes(r.content)
                return True
            print(f"  HTTP {r.status_code} for {url}")
        except requests.RequestException as e:
            print(f"  error {e} (attempt {attempt + 1})")
        time.sleep(2 * (attempt + 1))
    return False
