"""Verify the large (15') cutout cache against the small (6') one for the hero targets.

    python scripts/check_large_field.py [target ...]

1. position: for every visit, the target's proper-motion-predicted position in the common grid vs the
   centroid of the star actually found there in the stacked frame (offset in output pixels and arcsec).
2. photometry: aperture flux measured on the same exposure in the 6' and 15' cutouts must agree.
3. coverage: frames/shape/n_images with the 15' cache, any exceptions from science.pipeline.
"""
import sys
import warnings
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
warnings.filterwarnings("ignore")

import astropy.units as u  # noqa: E402
from astropy.coordinates import SkyCoord  # noqa: E402

import api.load_cache as lc  # noqa: E402
from api import display, photometry  # noqa: E402
from api.targets import TARGETS, mjd_to_year, propagate  # noqa: E402
from science import pipeline  # noqa: E402

HERO = ["barnards-star", "eps-ind-b", "rw-aurigae"]


def check_positions(key):
    t = TARGETS[key]
    cutouts = lc.load_cutouts(key)
    fov = float(__import__("json").loads((lc.target_dir(key) / "index.json").read_text())["fov_arcmin"])
    print(f"\n=== {key}: {len(cutouts)} cutouts, cache {lc.target_dir(key).parent.name}/, fov {fov:g}'")
    try:
        frames = pipeline.build_frames(cutouts, t["ra"], t["dec"], fov)
    except Exception as e:  # noqa: BLE001
        print(f"  science.pipeline.build_frames EXCEPTION {type(e).__name__}: {e}")
        return
    print(f"  build_frames: {len(frames)} frames, shape {frames[0].image.shape}, n_images {[f.n_images for f in frames]}")
    L = display.LayerSet(cutouts, t["ra"], t["dec"], fov)
    print(f"  grid {L.shape}, usable cutouts {len(L.layers)}/{len(cutouts)}")
    pix_arcsec = abs(L.wcs_out.wcs.cdelt[0]) * 3600
    for e in range(len(L.epochs)):
        img = L.stack(epoch=e)[0]
        mjds = [m["mjd"] for m in L.meta if m["epoch"] == e]
        ra, dec = propagate(t, mjd_to_year(float(np.mean(mjds))))
        x, y = (float(v) for v in L.wcs_out.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg)))
        # brightest pixel within 6 px of the prediction, then a flux-weighted centroid in a 7x7 box
        yy, xx = np.mgrid[:img.shape[0], :img.shape[1]]
        near = np.hypot(xx - x, yy - y) <= 6
        a = np.where(near & np.isfinite(img), img, -np.inf)
        py, px = np.unravel_index(np.argmax(a), a.shape)
        box = np.nan_to_num(img[py - 3:py + 4, px - 3:px + 4] - np.nanmedian(img))
        box = np.clip(box, 0, None)
        cy = py - 3 + (box.sum(1) * np.arange(7)).sum() / box.sum()
        cx = px - 3 + (box.sum(0) * np.arange(7)).sum() / box.sum()
        off = np.hypot(cx - x, cy - y)
        print(f"  visit {e + 1}: predicted ({x:.1f},{y:.1f}) centre of grid ({(L.shape[1] - 1) / 2:.0f},{(L.shape[0] - 1) / 2:.0f}) "
              f"measured ({cx:.1f},{cy:.1f}) offset {off:.1f} px = {off * pix_arcsec:.1f}\"")


def check_photometry(key):
    t = TARGETS[key]
    small = lc.CACHE_DIR / key / "cutouts"
    large = lc.CACHE_LARGE_DIR / key / "cutouts"
    common = sorted(p.name for p in large.glob("*.fits") if (small / p.name).exists())
    diffs, n_only_large = [], 0
    for name in common:
        a, b = photometry.measure(small / name, t), photometry.measure(large / name, t)
        if a and b:
            diffs.append((b["flux"] - a["flux"]) / abs(a["flux"]) if a["flux"] else np.nan)
        elif b and not a:
            n_only_large += 1
    d = np.array([x for x in diffs if np.isfinite(x)])
    n_small = sum(1 for p in common if photometry.measure(small / p, t))
    n_large = sum(1 for p in common if photometry.measure(large / p, t))
    print(f"  photometry on {len(common)} common exposures: measurable in 6' {n_small}, in 15' {n_large} ({n_only_large} only thanks to the bigger field)")
    print(f"  flux difference 15' vs 6' on {len(d)} exposures: median {np.median(d) * 100:+.3f}%, 95% within +-{np.percentile(np.abs(d), 95) * 100:.2f}%, max {np.max(np.abs(d)) * 100:.2f}%")


if __name__ == "__main__":
    for key in (sys.argv[1:] or HERO):
        check_positions(key)
        check_photometry(key)
