"""SPHEREx's 102 spectral channels ("bands"): 6 detectors x 17 channels, from the official SPECTRAL_CHANNELS
table (api/spectral_channels.json, copied from spectral_channels_spx_cal-sch-v2-2026-229.fits, NASA/IPAC IRSA).

band_index runs 0..101 in order of wavelength (detector 1 channel 1 ... detector 6 channel 17).
"""
import json
from pathlib import Path

CHANNELS = json.loads((Path(__file__).parent / "spectral_channels.json").read_text())["channels"]
EDGE_TOLERANCE_UM = 0.002   # a wavelength this close outside a channel's [min, max] still counts as inside it


def assign(detector: int, wavelength_um: float | None) -> int | None:
    """Band index of an exposure from its detector and the wavelength at the target.

    The channel of THAT detector whose centre is nearest (neighbouring channels overlap by a few nm).
    None if the wavelength is outside the detector's channels (the LVF extends slightly beyond them)."""
    if wavelength_um is None:
        return None
    mine = [c for c in CHANNELS if c["detector"] == detector]
    if not mine:
        return None
    best = min(mine, key=lambda c: abs(c["wavelength_um"] - wavelength_um))
    if best["wavelength_um_min"] - EDGE_TOLERANCE_UM <= wavelength_um <= best["wavelength_um_max"] + EDGE_TOLERANCE_UM:
        return best["band_index"]
    return None
