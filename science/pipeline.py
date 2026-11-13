"""Science pipeline stubs (Futa implements these).

The API calls `build_frames` and `difference`. While they raise
NotImplementedError the API uses its own simple fallback, and it switches
to the real versions automatically once they are implemented.
"""
from science.types import Cutout, Frame
import numpy as np


def build_frames(cutouts: list[Cutout], ra: float, dec: float, fov_arcmin: float) -> list[Frame]:
    raise NotImplementedError


def difference(a: Frame, b: Frame) -> np.ndarray:
    """Return a difference image (float array) between frames a and b."""
    raise NotImplementedError
