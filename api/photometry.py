"""Aperture photometry of a target in every cached cutout -> a spectrum (flux vs wavelength).

Built on top of the cache and the pixel mask in api/fallback.py; science/pipeline.py is not touched.

Method (per cutout):
  * position  = the target's catalogue position moved by proper motion to the cutout's observation time
  * image     = IMAGE - ZODI (same as Cutout.image)
  * aperture  = circle of radius AP_RADIUS_PX around the position (pixel centres inside the circle)
  * background= median of the good pixels in the annulus ANNULUS_PX (robust against neighbouring stars)
  * flux      = sum(image - background) over the good aperture pixels; masked aperture pixels are
                filled in by scaling with N_aperture / N_good
  * unit      = Jy (MJy/sr summed over pixels x pixel solid angle from the WCS)
  * flux_err  = sqrt(sum of the VARIANCE plane over the aperture) in the same unit (statistical only)
  * bad pixels use MASK (api/fallback.py) which keeps the saturated-core bits, see below.

Saturation: bright stars (Barnard's Star, R Dra) have OVERFLOW-flagged pixels in the core. Those pixel
values are unreliable, so the aperture sum is biased LOW. We keep the pixels (dropping them would remove
the brightest part of the star) and set saturated=True on the point so a client can grey it out or treat
it as a lower limit. No aperture correction is applied (r=3 px encloses ~94% of the flux at 1-5 um for
the data we measured on Barnard's Star).
"""
import warnings
from functools import lru_cache

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_area

from api.fallback import MASK
from api.load_cache import CACHE_DIR, _quiet_astropy, load_index, target_dir, wavelength_at
from api.targets import TARGETS, mjd_to_year, propagate

_quiet_astropy()  # this module reads FITS headers directly

AP_RADIUS_PX = 3.0
ANNULUS_PX = (8.0, 14.0)
MIN_APERTURE_GOOD_FRACTION = 0.7   # skip a cutout if more than 30% of the aperture is bad / off the image
MIN_ANNULUS_PIXELS = 30
OVERFLOW_BIT = 1 << 1


def measure(path, target: dict) -> dict | None:
    """One flux point from one cutout file, or None if the target is not usefully inside it."""
    with fits.open(path) as hdul:
        hdr = hdul["IMAGE"].header
        mjd = float(hdr["MJD-AVG"])
        det = int(hdr.get("DETECTOR", 0))
        image = np.array(hdul["IMAGE"].data, dtype=float)
        if "ZODI" in hdul:
            image -= np.array(hdul["ZODI"].data, dtype=float)
        flags = np.array(hdul["FLAGS"].data) if "FLAGS" in hdul else np.zeros(image.shape, dtype=int)
        var = np.array(hdul["VARIANCE"].data, dtype=float) if "VARIANCE" in hdul else None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wcs = WCS(hdr)
            ra, dec = propagate(target, mjd_to_year(mjd))
            x, y = (float(v) for v in wcs.world_to_pixel_values(ra, dec))
            pix_sr = proj_plane_pixel_area(wcs.celestial) * (np.pi / 180) ** 2
        ny, nx = image.shape
        if not (0 <= x < nx and 0 <= y < ny):
            return None
        wavelength = wavelength_at(hdul, x, y)

    yy, xx = np.mgrid[:ny, :nx]
    r = np.hypot(xx - x, yy - y)
    good = np.isfinite(image) & ((flags & MASK) == 0)
    ap = r <= AP_RADIUS_PX
    ann = (r >= ANNULUS_PX[0]) & (r <= ANNULUS_PX[1]) & good
    ap_good = ap & good
    if ap_good.sum() < MIN_APERTURE_GOOD_FRACTION * ap.sum() or ann.sum() < MIN_ANNULUS_PIXELS:
        return None
    background = float(np.median(image[ann]))
    scale = ap.sum() / ap_good.sum()                       # fill in masked aperture pixels
    to_jy = 1e6 * pix_sr                                    # MJy/sr per pixel -> Jy per pixel
    flux = float((image[ap_good] - background).sum() * scale * to_jy)
    err = float(np.sqrt(np.nansum(var[ap_good])) * scale * to_jy) if var is not None else None
    return {"wavelength_um": None if wavelength is None else round(wavelength, 5), "flux": flux,
            "flux_err": err, "detector": det, "mjd": mjd,
            "saturated": bool(((flags[ap] & OVERFLOW_BIT) != 0).any()),
            "n_masked": int(ap.sum() - ap_good.sum())}


@lru_cache(maxsize=16)
def spectrum(key: str) -> dict:
    """The spectrum of a cached target: every cutout that contains it, sorted by wavelength."""
    target = TARGETS[key]
    points, n_outside, n_nowave = [], 0, 0
    for row in load_index(key):
        pt = measure(target_dir(key) / "cutouts" / row["file"], target)
        if pt is None:
            n_outside += 1
        elif pt["wavelength_um"] is None:
            n_nowave += 1
        else:
            points.append(pt)
    points.sort(key=lambda p: p["wavelength_um"])
    return {"target": key, "name": target["name"], "ra": target["ra"], "dec": target["dec"],
            "flux_unit": "Jy", "aperture_radius_px": AP_RADIUS_PX, "background_annulus_px": list(ANNULUS_PX),
            "n_points": len(points), "n_saturated": sum(p["saturated"] for p in points),
            "n_cutouts_skipped": n_outside, "n_without_wavelength": n_nowave, "spectrum": points}
