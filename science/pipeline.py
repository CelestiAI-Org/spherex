"""Science pipeline (Futa): cutouts -> one combined frame per epoch, and a difference image.

build_frames steps:
  0. optionally keep only some detectors (detectors=...)
  1. drop unusable cutouts (target outside the image, too few valid pixels)      usable_cutouts
  2. sort by time and split into epochs (a gap longer than EPOCH_GAP_DAYS starts one) split_epochs
  3. clean each cutout: mask bad pixels with BAD_PIXEL_MASK, subtract the median level   clean_cutout
  4. reproject every cutout onto one common sky grid centred on (ra, dec)        common_grid
  5. median-stack the cutouts of each epoch (NaN ignored)                         stack_by_epoch
  6. one common brightness range for all frames, scaled to 0-1                    scale_to_unit

The names above are the building blocks; science/check_*.py reuse them so the checks run on exactly the
same stacks that build_frames makes. The old underscore names (_usable, _split_epochs, _clean, _common_wcs)
are kept at the bottom because api/display.py and scripts/check_pipeline.py import them.
"""
import warnings

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
import astropy.units as u
from reproject import reproject_interp

from api.load_cache import BAD_PIXEL_MASK
from science.types import Cutout, Frame

# Saturated cores of bright stars carry bits 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR and 26 BLOOM.
# Masking them punches a black hole into the star we want to follow (seen on Barnard's Star),
# so for display we keep those four bits (same choice as api/fallback.py).
KEEP_BITS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 26)
MASK = BAD_PIXEL_MASK & ~KEEP_BITS

OVERSAMPLE = 2            # output pixels per native SPHEREx pixel (smoother picture; native scale is ~6.15 arcsec)
EPOCH_GAP_DAYS = 60       # CACHE.md: passes are 100+ days apart, one pass spans 20-50 days
MIN_VALID_FRACTION = 0.5  # drop cutouts with fewer valid pixels than this
DEFAULT_PIXEL_ARCSEC = 6.15
BRIGHTNESS_PERCENTILES = (1, 99)   # frames are scaled so that this range maps to 0-1


# ---------------------------------------------------------------------------------------------------
# building blocks
# ---------------------------------------------------------------------------------------------------

def usable_cutouts(cutouts, center):
    """Step 1: keep cutouts where the target is inside the image and enough pixels are valid."""
    keep = []
    for c in cutouts:
        ny, nx = c.image.shape
        x, y = c.wcs.world_to_pixel(center)
        good = (c.flags & MASK) == 0
        valid = np.isfinite(c.image) & good
        if 0 <= x < nx and 0 <= y < ny and valid.mean() >= MIN_VALID_FRACTION:
            keep.append(c)
    return keep


def split_epochs(cutouts):
    """Step 2: group cutouts (sorted by time) into epochs."""
    cs = sorted(cutouts, key=lambda c: c.mjd)
    groups, current = [], [cs[0]]
    for c in cs[1:]:
        if c.mjd - current[-1].mjd > EPOCH_GAP_DAYS:
            groups.append(current)
            current = []
        current.append(c)
    groups.append(current)
    return groups


def clean_cutout(c):
    """Step 3: bad pixels -> NaN, then subtract the median level (zodi is already removed in c.image)."""
    img = np.array(c.image, dtype=float)
    img[(c.flags & MASK) != 0] = np.nan
    return img - np.nanmedian(img)


def native_pixel_arcsec(c):
    """Native pixel scale of a cutout in arcsec (DEFAULT_PIXEL_ARCSEC if its WCS cannot tell)."""
    try:
        return float(np.mean(proj_plane_pixel_scales(c.wcs)) * 3600)
    except Exception:  # noqa: BLE001
        return DEFAULT_PIXEL_ARCSEC


def common_grid(ra, dec, fov_arcmin, pixel_arcsec):
    """Step 4a: a tangent-plane grid centred on the target -> (WCS, (ny, nx))."""
    n = int(round(fov_arcmin * 60 / pixel_arcsec))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-pixel_arcsec / 3600, -pixel_arcsec / 3600]  # row 0 = north, RA grows to the left (like the PNG/fallback)
    return w, (n, n)


def stack_by_epoch(usable, wcs_out, shape):
    """Steps 2-5: -> list of (cutouts of the epoch, median stack on the common grid).

    The stack is NOT scaled: pixels are in the cleaned image units and NaN where no cutout has data.
    """
    stacks = []
    for group in split_epochs(usable):
        layers = [reproject_interp((clean_cutout(c), c.wcs), wcs_out, shape_out=shape)[0] for c in group]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)   # all-NaN pixels give a harmless warning
            stacks.append((group, np.nanmedian(np.stack(layers), axis=0)))
    return stacks


def scale_to_unit(images):
    """Step 6: scale all images with ONE brightness range (fair comparison) to 0-1; no data -> 0 (black)."""
    pix = np.concatenate([s[np.isfinite(s)] for s in images])
    lo, hi = np.percentile(pix, BRIGHTNESS_PERCENTILES)
    return [np.nan_to_num(np.clip((s - lo) / (hi - lo), 0.0, 1.0), nan=0.0) for s in images]


# ---------------------------------------------------------------------------------------------------
# what the API calls
# ---------------------------------------------------------------------------------------------------

def build_frames(cutouts: list[Cutout], ra: float, dec: float, fov_arcmin: float,
                 detectors=None) -> list[Frame]:
    """detectors: optional iterable of detector numbers (1-6) to stack, e.g. {5, 6}.

    None (default) uses every detector. A faint target such as WISE 0855 is only visible at the
    longest wavelengths (D5+D6, 3.8-5.0 um); stacking all detectors washes the signal out.
    """
    if not cutouts:
        return []
    if detectors is not None:
        wanted = {int(d) for d in detectors}
        cutouts = [c for c in cutouts if c.detector in wanted]
        if not cutouts:
            raise ValueError(f"no cutouts for detectors {sorted(wanted)}")
    center = SkyCoord(ra * u.deg, dec * u.deg)
    usable = usable_cutouts(cutouts, center)
    if not usable:
        raise ValueError("no usable cutout (target outside every image, or too many bad pixels)")

    wcs_out, shape = common_grid(ra, dec, fov_arcmin, native_pixel_arcsec(usable[0]) / OVERSAMPLE)
    epochs = stack_by_epoch(usable, wcs_out, shape)
    scaled = scale_to_unit([stack for _, stack in epochs])
    return [Frame(image=img, mjd_start=group[0].mjd, mjd_end=group[-1].mjd, n_images=len(group))
            for (group, _), img in zip(epochs, scaled)]


def difference(a: Frame, b: Frame) -> np.ndarray:
    """Return a difference image between frames a and b: b - a (later minus earlier)."""
    if a.image.shape != b.image.shape:
        raise ValueError("frames must have the same shape")
    return b.image - a.image


# ---------------------------------------------------------------------------------------------------
# old names, kept because other code imports them (api/display.py, scripts/check_pipeline.py)
# ---------------------------------------------------------------------------------------------------
_usable = usable_cutouts
_split_epochs = split_epochs
_clean = clean_cutout
_common_wcs = common_grid
