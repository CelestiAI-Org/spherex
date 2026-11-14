"""Check predicted positions (proper motion + parallax) against the real data, one frame per epoch.

Run from the repo root (NOT from inside science/):

    python -m science.check_predicted barnards-star          # bright star: centroid vs prediction
    python -m science.check_predicted wise-0855-0714 --snr   # faint target: aperture S/N at the prediction
    python -m science.check_predicted wise-0855-0714 --snr --det 6     # only detector 6 (or --det 5,6)

--snr measures the flux in a small circle (aperture) at the predicted position, minus the sky level from
a ring around it, and divides by the noise. The noise is the scatter (1.4826 * MAD) of the same measurement
at ~500 random empty-sky positions in the same frame. It also reports how many random positions are as bright,
and the strongest spot within SEARCH_NATIVE_PX of the prediction. Writes predicted_check.png.
"""
import math
import sys
import warnings

import matplotlib
import numpy as np
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.wcs.utils import proj_plane_pixel_scales
from reproject import reproject_interp

from api.load_cache import load_cutouts
from api.targets import TARGETS
from science import pipeline as P
from science.predict import PARALLAX_MAS, predicted_pixel

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

FOV_ARCMIN = 6.0
HALF = 8                  # half-width (output pixels) of the centroid window
# Aperture photometry, in NATIVE SPHEREx pixels (converted to output pixels with OVERSAMPLE)
AP_NATIVE_PX = 2.0        # aperture radius
RING_NATIVE_PX = (6.0, 12.0)   # sky ring (inner, outer radius)
SEARCH_NATIVE_PX = 2.0    # look for the strongest spot this close to the prediction
N_RANDOM = 500            # random empty-sky positions used to measure the noise


def aperture_flux(img, x, y, ap, ring):
    """Sum of (pixel - ring median) inside the aperture; NaN if too many pixels are missing."""
    n_y, n_x = img.shape
    yy, xx = np.ogrid[:n_y, :n_x]
    r = np.hypot(xx - x, yy - y)
    a, b = img[r <= ap], img[(r >= ring[0]) & (r <= ring[1])]
    if a.size == 0 or b.size == 0 or np.isfinite(a).mean() < 0.9 or np.isfinite(b).mean() < 0.9:
        return np.nan
    return float(np.nansum(a - np.nanmedian(b)))


def snr_at(img, x, y, rng):
    """-> dict(flux, noise, snr, false_alarm, best_snr, best_offset) for a prediction at (x, y)."""
    ap = AP_NATIVE_PX * P.OVERSAMPLE
    ring = (RING_NATIVE_PX[0] * P.OVERSAMPLE, RING_NATIVE_PX[1] * P.OVERSAMPLE)
    n = img.shape[0]
    lo, hi = ring[1] + 1, n - 1 - ring[1] - 1
    rand = []
    for _ in range(N_RANDOM * 4):
        rx, ry = rng.uniform(lo, hi, 2)
        if math.hypot(rx - x, ry - y) < 2 * ap + 4:          # keep away from the target itself
            continue
        f = aperture_flux(img, rx, ry, ap, ring)
        if np.isfinite(f):
            rand.append(f)
        if len(rand) >= N_RANDOM:
            break
    rand = np.array(rand)
    centre, noise = np.median(rand), 1.4826 * np.median(np.abs(rand - np.median(rand)))
    flux = aperture_flux(img, x, y, ap, ring)
    # strongest spot near the prediction (tests whether the prediction is off by a pixel or two)
    reach = int(math.ceil(SEARCH_NATIVE_PX * P.OVERSAMPLE))
    best = (-np.inf, 0.0, 0.0)
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            f = aperture_flux(img, x + dx, y + dy, ap, ring)
            if np.isfinite(f) and f > best[0]:
                best = (f, dx, dy)
    return dict(flux=flux, noise=noise, snr=(flux - centre) / noise,
                false_alarm=float(np.mean(rand >= flux)), n_random=len(rand),
                best_snr=(best[0] - centre) / noise,
                best_offset_arcsec=math.hypot(best[1], best[2]) * (P.DEFAULT_PIXEL_ARCSEC / P.OVERSAMPLE))


def main(key: str, snr_mode: bool = False, detectors=None):
    t = {**TARGETS[key], "plx": PARALLAX_MAS.get(key, 0.0)}
    cuts = load_cutouts(key)
    if detectors:
        cuts = [c for c in cuts if c.detector in detectors]
    use = P._usable(cuts, SkyCoord(t["ra"] * u.deg, t["dec"] * u.deg))
    native = float(np.mean(proj_plane_pixel_scales(use[0].wcs)) * 3600)
    pix = native / P.OVERSAMPLE
    wcs, shape = P._common_wcs(t["ra"], t["dec"], FOV_ARCMIN, pix)
    print(f"{key}: {len(use)} cutouts, native {native:.2f} arcsec/px, output grid {shape} at {pix:.2f} arcsec/px")
    rng = np.random.default_rng(0)

    rows = []
    for g in P._split_epochs(use):
        layers = [reproject_interp((P._clean(c), c.wcs), wcs, shape_out=shape)[0] for c in g]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            raw = np.nanmedian(np.stack(layers), axis=0)
        mjd = float(np.mean([c.mjd for c in g]))
        x, y = predicted_pixel(t, mjd, wcs)
        if snr_mode:
            s = snr_at(raw, x, y, rng)
            rows.append((mjd, len(g), x, y, raw, s))
            print(f"MJD {mjd:.1f} n={len(g):3d}  predicted ({x:.1f},{y:.1f})  S/N at prediction {s['snr']:+.1f}  "
                  f"(random positions as bright: {100 * s['false_alarm']:.1f}% of {s['n_random']})  "
                  f"strongest spot within {SEARCH_NATIVE_PX:g} px: S/N {s['best_snr']:.1f}, "
                  f"{s['best_offset_arcsec']:.1f} arcsec from the prediction")
        else:
            x0, y0 = predicted_pixel(t, mjd, wcs, parallax_mas=0.0)     # proper motion only
            xi, yi = int(round(x)), int(round(y))
            win = np.nan_to_num(raw[yi - HALF:yi + HALF + 1, xi - HALF:xi + HALF + 1])
            win = np.clip(win - np.median(win[[0, -1]]), 0, None)        # subtract the edge level
            yy, xx = np.mgrid[yi - HALF:yi + HALF + 1, xi - HALF:xi + HALF + 1]
            xm, ym = (win * xx).sum() / win.sum(), (win * yy).sum() / win.sum()
            rows.append((mjd, len(g), x, y, raw, (xm, ym)))
            print(f"MJD {mjd:.1f} n={len(g):3d}  predicted ({x:.2f},{y:.2f})  measured ({xm:.2f},{ym:.2f})  "
                  f"difference {math.hypot(xm - x, ym - y) * pix:.2f} arcsec  "
                  f"(parallax part {math.hypot(x - x0, y - y0) * pix:.2f} arcsec)")

    if not snr_mode:
        a, b = rows[0], rows[-1]
        pred = math.hypot(b[2] - a[2], b[3] - a[3])
        meas = math.hypot(b[5][0] - a[5][0], b[5][1] - a[5][1])
        print(f"Motion first -> last epoch: predicted {pred * pix:.1f} arcsec, measured {meas * pix:.1f} arcsec "
              f"({pred / P.OVERSAMPLE:.2f} native px, {pred:.1f} px of the {shape[0]}-px frame)")

    fig, axes = plt.subplots(1, len(rows), figsize=(4 * len(rows), 4.3))
    for ax, (mjd, n, x, y, raw, m) in zip(np.atleast_1d(axes), rows):
        lo, hi = np.nanpercentile(raw, [1, 99])
        ax.imshow(raw, origin="upper", cmap="gray", vmin=lo, vmax=hi)
        ax.add_patch(plt.Circle((x, y), AP_NATIVE_PX * P.OVERSAMPLE, fill=False, color="cyan", lw=1))
        if snr_mode:
            ax.set_title(f"MJD {mjd:.0f} n={n}  S/N at prediction {m['snr']:+.1f}", fontsize=8)
        else:
            ax.plot([m[0]], [m[1]], "r+", ms=8)
            ax.set_title(f"MJD {mjd:.0f} n={n}  (cyan = predicted, red + = measured)", fontsize=7)
        ax.axis("off")
    fig.savefig("predicted_check.png", dpi=110, bbox_inches="tight")
    print("saved predicted_check.png")


if __name__ == "__main__":
    argv = sys.argv[1:]
    dets = None
    if "--det" in argv:                      # e.g. --det 6   or   --det 5,6
        i = argv.index("--det")
        dets = {int(d) for d in argv[i + 1].split(",")}
        del argv[i:i + 2]
    args = [a for a in argv if not a.startswith("--")]
    main(args[0] if args else "barnards-star", snr_mode="--snr" in argv, detectors=dets)
