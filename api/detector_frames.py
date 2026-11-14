"""One stacked frame per SPHEREx detector (1-6), built on the helpers in science/pipeline.py.

Same steps and the same sky grid as build_frames (usable-cutout test, bad-pixel mask, median level
removal, reprojection onto a common grid centred on the target, median stack, 1-99 percentile scale),
except that the cutouts are grouped by detector instead of by epoch, and ALL epochs of a detector are
stacked together. Every detector uses ONE shared brightness range, so the frames are comparable.

Note: a fast mover (Barnard's Star ~10"/yr) is slightly smeared because all epochs are combined.
The detectors cover different wavelengths (an LVF per detector): D1 ~0.75-1.1 um ... D6 ~4.4-5.0 um.
"""
import warnings

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.wcs.utils import proj_plane_pixel_scales
from reproject import reproject_interp

from science import pipeline  # uses its (private) helpers; its logic is not changed


def stack_by_detector(cutouts, ra: float, dec: float, fov_arcmin: float):
    """-> list of 6 dicts {detector, n_images, wavelength_range_um, image (0-1 array or None)}."""
    center = SkyCoord(ra * u.deg, dec * u.deg)
    usable = pipeline._usable(cutouts, center)
    stacks = {}
    if usable:
        pixel_arcsec = float(np.mean(proj_plane_pixel_scales(usable[0].wcs)) * 3600)
        wcs_out, shape = pipeline._common_wcs(ra, dec, fov_arcmin, pixel_arcsec / pipeline.OVERSAMPLE)
        for det in range(1, 7):
            group = [c for c in usable if c.detector == det]
            if not group:
                continue
            layers = [reproject_interp((pipeline._clean(c), c.wcs), wcs_out, shape_out=shape)[0] for c in group]
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                stacks[det] = np.nanmedian(np.stack(layers), axis=0)

    scale = None
    if stacks:
        pix = np.concatenate([s[np.isfinite(s)] for s in stacks.values()])
        scale = np.percentile(pix, [1, 99])                    # ONE range for all detectors
    out = []
    for det in range(1, 7):
        group = [c for c in usable if c.detector == det]
        waves = [c.wavelength_um for c in group if c.wavelength_um is not None]
        entry = {"detector": det, "n_images": len(group),
                 "wavelength_range_um": [round(min(waves), 3), round(max(waves), 3)] if waves else None,
                 "image": None}
        if det in stacks:
            lo, hi = scale
            entry["image"] = np.nan_to_num(np.clip((stacks[det] - lo) / (hi - lo), 0, 1), nan=0.0)
        else:
            entry["note"] = "no usable cutout for this detector (target outside the images or too many bad pixels)"
        out.append(entry)
    return out
