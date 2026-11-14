"""Run science.pipeline.build_frames on every cached target and report what happens.

    python scripts/check_pipeline.py [target ...]

Reports per target: ra/dec passed in (the API passes the cache centre = epoch-2026 position), frames,
shape, n_images, exceptions, how many cutouts _usable() keeps, and whether the target's true position
(catalogue position moved by proper motion to each frame's mid-time) lies inside the grid.
"""
import sys
import time
import traceback
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from astropy.coordinates import SkyCoord  # noqa: E402
import astropy.units as u  # noqa: E402

from api.load_cache import load_cutouts  # noqa: E402
from api.main import cached_fov  # noqa: E402
from api.targets import TARGETS, propagate  # noqa: E402
from science import pipeline  # noqa: E402


def mjd_to_year(mjd):
    return 2000.0 + (mjd - 51544.5) / 365.25


def check(key):
    t = TARGETS[key]
    cutouts = load_cutouts(key)
    fov = cached_fov(key)
    ra, dec = t["ra"], t["dec"]
    print(f"\n=== {key}: {len(cutouts)} cutouts, API passes ra={ra:.5f} dec={dec:.5f} fov={fov}  (catalogue ra={t['ra_cat']:.5f} dec={t['dec_cat']:.5f})")
    usable = pipeline._usable(cutouts, SkyCoord(ra * u.deg, dec * u.deg))
    print(f"  _usable keeps {len(usable)}/{len(cutouts)}")
    t0 = time.time()
    try:
        frames = pipeline.build_frames(cutouts, ra, dec, fov)
    except Exception as e:  # noqa: BLE001
        print(f"  EXCEPTION {type(e).__name__}: {e}")
        traceback.print_exc(limit=3)
        return
    print(f"  {len(frames)} frames in {time.time() - t0:.1f}s")
    if not frames:
        return
    pix = float(np.mean(pipeline.proj_plane_pixel_scales(usable[0].wcs)) * 3600)
    wcs_out, shape = pipeline._common_wcs(ra, dec, fov, pix / pipeline.OVERSAMPLE)
    for i, f in enumerate(frames):
        tra, tdec = propagate(t, mjd_to_year((f.mjd_start + f.mjd_end) / 2))
        x, y = wcs_out.world_to_pixel(SkyCoord(tra * u.deg, tdec * u.deg))
        inside = 0 <= x < shape[1] and 0 <= y < shape[0]
        data = (f.image > 0).mean()
        print(f"  frame {i}: shape={f.image.shape} n_images={f.n_images} mjd={f.mjd_start:.0f}-{f.mjd_end:.0f} "
              f"min/max={f.image.min():.2f}/{f.image.max():.2f} non-black={data:.2f} "
              f"target at pixel ({x:.1f},{y:.1f}) {'INSIDE' if inside else 'OUTSIDE'} grid")


if __name__ == "__main__":
    keys = sys.argv[1:] or ["barnards-star", "wise-0855-0714", "eps-ind-b", "rw-aurigae", "r-draconis", "fake_mover"]
    for k in keys:
        check(k)
