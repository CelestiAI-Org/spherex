"""Science pipeline (Futa): cutouts -> one combined frame per epoch, and a difference image.

build_frames steps:
  0. optionally keep only some detectors (detectors=...)
  1. drop unusable cutouts (target outside the image, too few valid pixels)
  2. sort by time and split into epochs (a gap longer than EPOCH_GAP_DAYS starts a new epoch)
  3. clean each cutout: mask bad pixels with BAD_PIXEL_MASK, subtract the median level
  4. reproject every cutout onto one common sky grid centred on (ra, dec)
  5. median-stack the cutouts of each epoch (NaN ignored)
  6. one common brightness range for all frames, scaled to 0-1
"""
import warnings

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
import astropy.units as u
from reproject import reproject_interp

from api.load_cache import BAD_PIXEL_MASK

# Saturated cores of bright stars carry bits 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR and 26 BLOOM.
# Masking them punches a black hole into the star we want to follow (seen on Barnard's Star),
# so for display we keep those four bits (same choice as api/fallback.py).
KEEP_BITS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 26)
MASK = BAD_PIXEL_MASK & ~KEEP_BITS
OVERSAMPLE = 2  # output pixels per native SPHEREx pixel (smoother picture; native scale is ~6.15 arcsec)
from science.types import Cutout, Frame

EPOCH_GAP_DAYS = 60       # CACHE.md: passes are 100+ days apart, one pass spans 20-50 days
MIN_VALID_FRACTION = 0.5  # drop cutouts with fewer valid pixels than this
DEFAULT_PIXEL_ARCSEC = 6.15


def _usable(cutouts, center):
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


def _split_epochs(cutouts):
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


def _clean(c):
    """Step 3: bad pixels -> NaN, then subtract the median level (zodi is already removed in c.image)."""
    img = np.array(c.image, dtype=float)
    img[(c.flags & MASK) != 0] = np.nan
    return img - np.nanmedian(img)


def _common_wcs(ra, dec, fov_arcmin, pixel_arcsec):
    """Step 4a: a tangent-plane grid centred on the target."""
    n = int(round(fov_arcmin * 60 / pixel_arcsec))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-pixel_arcsec / 3600, -pixel_arcsec / 3600]  # row 0 = north, RA grows to the left (like the PNG/fallback)
    return w, (n, n)


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
    usable = _usable(cutouts, center)
    if not usable:
        raise ValueError("no usable cutout (target outside every image, or too many bad pixels)")

    try:                                                  # pixel scale from the first WCS, in arcsec
        pixel_arcsec = float(np.mean(proj_plane_pixel_scales(usable[0].wcs)) * 3600)
    except Exception:  # noqa: BLE001
        pixel_arcsec = DEFAULT_PIXEL_ARCSEC
    wcs_out, shape = _common_wcs(ra, dec, fov_arcmin, pixel_arcsec / OVERSAMPLE)

    stacks, spans = [], []
    for group in _split_epochs(usable):
        layers = [reproject_interp((_clean(c), c.wcs), wcs_out, shape_out=shape)[0] for c in group]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)   # all-NaN pixels give a harmless warning
            stacks.append(np.nanmedian(np.stack(layers), axis=0))
        spans.append((group[0].mjd, group[-1].mjd, len(group)))

    pix = np.concatenate([s[np.isfinite(s)] for s in stacks])
    lo, hi = np.percentile(pix, [1, 99])                  # one range for ALL frames (fair comparison)
    frames = []
    for s, (t0, t1, n) in zip(stacks, spans):
        scaled = np.clip((s - lo) / (hi - lo), 0.0, 1.0)  # 0-1
        scaled = np.nan_to_num(scaled, nan=0.0)           # pixels with no data -> black
        frames.append(Frame(image=scaled, mjd_start=t0, mjd_end=t1, n_images=n))
    return frames


def difference(a: Frame, b: Frame) -> np.ndarray:
    """Return a difference image between frames a and b: b - a (later minus earlier)."""
    if a.image.shape != b.image.shape:
        raise ValueError("frames must have the same shape")
    return b.image - a.image
