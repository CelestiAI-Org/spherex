"""Simple stand-in for science.pipeline.build_frames, used until Futa's version exists.

1. Group cutouts into visits (observations closer together than VISIT_GAP_DAYS).
2. Resample each cutout onto a common sky grid centred on (ra, dec).
3. Median-combine each visit, then scale to 0-1.
"""
import numpy as np

from api.load_cache import BAD_PIXEL_MASK
from science.types import Cutout, Frame

# For display we keep saturated stars: bits 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR, 26 BLOOM mark the
# cores of bright stars (e.g. Barnard's Star). Masking them leaves a black hole in the middle.
KEEP_BITS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 26)
MASK = BAD_PIXEL_MASK & ~KEEP_BITS

VISIT_GAP_DAYS = 60.0  # real passes are ~20-50 days wide, ~100+ days apart
GRID_SIZE = 128  # output frame is GRID_SIZE x GRID_SIZE pixels


def group_visits(cutouts: list[Cutout]) -> list[list[Cutout]]:
    cutouts = sorted(cutouts, key=lambda c: c.mjd)
    visits: list[list[Cutout]] = []
    for c in cutouts:
        if visits and c.mjd - visits[-1][-1].mjd <= VISIT_GAP_DAYS:
            visits[-1].append(c)
        else:
            visits.append([c])
    return visits


def resample(cutout: Cutout, ra: float, dec: float, fov_arcmin: float, n: int = GRID_SIZE) -> np.ndarray:
    """Nearest-neighbour resample of one cutout onto an n x n tangent-plane grid (NaN where no data)."""
    half = fov_arcmin / 60.0 / 2.0
    offs = np.linspace(half, -half, n)  # RA increases to the left
    dx, dy = np.meshgrid(offs, np.linspace(half, -half, n))  # row 0 = north
    ras = ra + dx / np.cos(np.radians(dec))
    decs = dec + dy
    px, py = cutout.wcs.celestial.world_to_pixel_values(ras, decs)
    ix, iy = np.rint(px).astype(int), np.rint(py).astype(int)
    ny, nx = cutout.image.shape
    ok = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    out = np.full((n, n), np.nan)
    ixc, iyc = np.clip(ix, 0, nx - 1), np.clip(iy, 0, ny - 1)
    vals = cutout.image[iyc, ixc].astype(float)
    good = ok & ((cutout.flags[iyc, ixc] & MASK) == 0) & np.isfinite(vals)
    out[good] = vals[good]
    return out


def scale01(img: np.ndarray) -> np.ndarray:
    finite = img[np.isfinite(img)]
    if finite.size == 0:
        return np.zeros_like(img)
    lo, hi = np.percentile(finite, [1, 99.5])
    if hi <= lo:
        return np.zeros_like(img)
    return np.nan_to_num(np.clip((img - lo) / (hi - lo), 0, 1), nan=0.0)


def build_frames(cutouts: list[Cutout], ra: float, dec: float, fov_arcmin: float) -> list[Frame]:
    frames = []
    for visit in group_visits(cutouts):
        stack = np.array([resample(c, ra, dec, fov_arcmin) for c in visit])
        if np.all(np.isnan(stack)):
            continue  # this visit does not cover the requested field
        with np.errstate(all="ignore"):
            combined = np.nanmedian(stack, axis=0)
        frames.append(Frame(image=scale01(combined),
                            mjd_start=min(c.mjd for c in visit),
                            mjd_end=max(c.mjd for c in visit),
                            n_images=len(visit)))
    return frames


def difference(a: Frame, b: Frame) -> np.ndarray:
    """Plain subtraction of two scaled frames, in the range -1..1."""
    return a.image - b.image
