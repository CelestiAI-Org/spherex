from dataclasses import dataclass

import numpy as np
from astropy.wcs import WCS


@dataclass
class Cutout:
    image: np.ndarray   # SPHEREx image minus background (zodi)
    flags: np.ndarray   # bad-pixel flags
    wcs: WCS            # pixel <-> sky coordinates
    mjd: float          # observation time
    detector: int       # 1–6
    wavelength_um: float | None = None  # central wavelength (um) at the target position, from WCS-WAVE

@dataclass
class Frame:
    image: np.ndarray   # combined, scaled 0–1
    mjd_start: float
    mjd_end: float
    n_images: int

def build_frames(cutouts: list[Cutout], ra: float, dec: float, fov_arcmin: float) -> list[Frame]: ...
