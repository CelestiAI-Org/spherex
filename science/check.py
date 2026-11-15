"""Checks that compare the pipeline's stacks with the catalogue. Run from the repo root (NOT from inside science/):

    python -m science.check predicted barnards-star                      # bright star: centroid vs prediction
    python -m science.check predicted wise-0855-0714 --snr --det 5,6    # faint target: aperture S/N at the prediction
    python -m science.check motion wise-0855-0714 --det 5,6             # does the spot MOVE like the proper motion?
    python -m science.check motion wise-0855-0714 --det 3               # control: a field star must NOT move

Both checks stack the cutouts exactly like science.pipeline.build_frames (same grid, same epochs), without the
0-1 scaling, and look at the predicted position (proper motion + parallax, science/predict.py) in every epoch.

predicted
    centroid mode (default): centroid of the star vs the predicted position.
    --snr: flux in a small circle (aperture) at the predicted position minus the sky level from a ring around it,
    divided by the noise = scatter (1.4826 * MAD) of the same measurement at ~500 random empty-sky positions.
    Also reports how many random positions are as bright and the strongest spot near the prediction.
    Writes predicted_check.png.
motion
    An aperture S/N cannot tell a mover from a stationary field star next to it (the aperture is bigger than the
    motion between visits). The centroid of the brightest spot per epoch can: a real mover shifts by pm * dt.
"""
import argparse
import math

import astropy.units as u
import matplotlib
import numpy as np
from astropy.coordinates import SkyCoord
from scipy.ndimage import gaussian_filter

from api.load_cache import load_cutouts
from api.targets import TARGETS
from science import pipeline as P
from science.predict import PARALLAX_MAS, predicted_pixel

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

FOV_ARCMIN = 6.0

# --- predicted: centroid mode and aperture photometry (NATIVE SPHEREx pixels, converted with OVERSAMPLE)
HALF = 8                       # half-width (output pixels) of the centroid window
AP_NATIVE_PX = 2.0             # aperture radius
RING_NATIVE_PX = (6.0, 12.0)   # sky ring (inner, outer radius)
SEARCH_NATIVE_PX = 2.0         # look for the strongest spot this close to the prediction
N_RANDOM = 500                 # random empty-sky positions used to measure the noise

# --- motion
SEARCH_PX = 5                  # search radius around the prediction, in output pixels
SMOOTH_PX = 1.5                # gaussian sigma used only to pick the brightest spot
SPOT_HALF = 4                  # centroid window half-size, in output pixels


# ---------------------------------------------------------------------------------------------------
# shared: the same stacks as build_frames
# ---------------------------------------------------------------------------------------------------

def epoch_stacks(key, target, detectors=None, fov_arcmin=FOV_ARCMIN):
    """-> (epochs, wcs, shape, native_arcsec, n_usable).

    epochs = [dict(mjd=mean mjd, n=number of cutouts, raw=unscaled median stack on the common grid)].
    """
    cuts = load_cutouts(key)
    if detectors:
        cuts = [c for c in cuts if c.detector in detectors]
    use = P.usable_cutouts(cuts, SkyCoord(target["ra"] * u.deg, target["dec"] * u.deg))
    if not use:
        raise SystemExit("no usable cutouts for these detectors")
    native = P.native_pixel_arcsec(use[0])
    wcs, shape = P.common_grid(target["ra"], target["dec"], fov_arcmin, native / P.OVERSAMPLE)
    epochs = [dict(mjd=float(np.mean([c.mjd for c in group])), n=len(group), raw=raw)
              for group, raw in P.stack_by_epoch(use, wcs, shape)]
    return epochs, wcs, shape, native, len(use)


# ---------------------------------------------------------------------------------------------------
# predicted
# ---------------------------------------------------------------------------------------------------

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
    """-> dict(flux, noise, snr, false_alarm, best_snr, best_offset_arcsec) for a prediction at (x, y)."""
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


def run_predicted(key: str, snr_mode: bool = False, detectors=None):
    t = {**TARGETS[key], "plx": PARALLAX_MAS.get(key, 0.0)}
    epochs, wcs, shape, native, n_use = epoch_stacks(key, t, detectors)
    pix = native / P.OVERSAMPLE
    print(f"{key}: {n_use} cutouts, native {native:.2f} arcsec/px, output grid {shape} at {pix:.2f} arcsec/px")
    rng = np.random.default_rng(0)

    rows = []
    for e in epochs:
        mjd, n, raw = e["mjd"], e["n"], e["raw"]
        x, y = predicted_pixel(t, mjd, wcs)
        if snr_mode:
            s = snr_at(raw, x, y, rng)
            rows.append((mjd, n, x, y, raw, s))
            print(f"MJD {mjd:.1f} n={n:3d}  predicted ({x:.1f},{y:.1f})  S/N at prediction {s['snr']:+.1f}  "
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
            rows.append((mjd, n, x, y, raw, (xm, ym)))
            print(f"MJD {mjd:.1f} n={n:3d}  predicted ({x:.2f},{y:.2f})  measured ({xm:.2f},{ym:.2f})  "
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


# ---------------------------------------------------------------------------------------------------
# motion
# ---------------------------------------------------------------------------------------------------

def brightest_spot(raw, x, y):
    """Centroid (cx, cy) of the brightest smoothed spot within SEARCH_PX of (x, y)."""
    yy, xx = np.mgrid[:raw.shape[0], :raw.shape[1]]
    sm = gaussian_filter(np.nan_to_num(raw), SMOOTH_PX)
    j = np.unravel_index(np.argmax(np.where(np.hypot(xx - x, yy - y) <= SEARCH_PX, sm, -np.inf)), sm.shape)
    h = SPOT_HALF
    win = np.clip(np.nan_to_num(raw[j[0] - h:j[0] + h + 1, j[1] - h:j[1] + h + 1]), 0, None)
    win = win - win.min()
    gy, gx = np.mgrid[j[0] - h:j[0] + h + 1, j[1] - h:j[1] + h + 1]
    return (win * gx).sum() / win.sum(), (win * gy).sum() / win.sum()


def run_motion(key: str, detectors=None, fov_arcmin=FOV_ARCMIN):
    t = TARGETS[key]
    epochs, wcs, shape, native, _ = epoch_stacks(key, t, detectors, fov_arcmin)
    pix = native / P.OVERSAMPLE
    rows = []
    for e in epochs:
        px, py = predicted_pixel(t, e["mjd"], wcs)
        rows.append(dict(mjd=e["mjd"], n=e["n"], pred=(px, py), spot=brightest_spot(e["raw"], px, py)))
    print(f"{key}: detectors {sorted(detectors) if detectors else 'all'}, output {pix:.2f} arcsec/px")
    for r in rows:
        d = math.hypot(r["spot"][0] - r["pred"][0], r["spot"][1] - r["pred"][1]) * pix
        print(f"  MJD {r['mjd']:.1f} n={r['n']:3d}  predicted ({r['pred'][0]:.1f},{r['pred'][1]:.1f})  "
              f"spot ({r['spot'][0]:.2f},{r['spot'][1]:.2f})  distance {d:.1f} arcsec")
    if len(rows) < 2:
        print("  need at least two epochs to measure motion")
        return
    first, last = rows[0], rows[-1]
    yrs = (last["mjd"] - first["mjd"]) / 365.25
    moved = math.hypot(last["spot"][0] - first["spot"][0], last["spot"][1] - first["spot"][1]) * pix
    expected = math.hypot(t["pmra"], t["pmdec"]) / 1000.0
    print(f"  spot motion first->last: {moved:.1f} arcsec in {yrs:.2f} yr = {moved / yrs:.1f} arcsec/yr "
          f"(catalogue proper motion {expected:.2f} arcsec/yr)")
    print("  -> moves like the catalogue says" if abs(moved / yrs - expected) < 0.35 * expected and expected > 1
          else "  -> does NOT move like a mover (stationary, e.g. a field star)" if moved / yrs < 0.3 * max(expected, 1e-9)
          else "  -> in between: inspect the image")


# ---------------------------------------------------------------------------------------------------

def _detectors(text):
    return {int(d) for d in text.split(",")} if text else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="check", required=True)

    p = sub.add_parser("predicted", help="predicted position vs the star (centroid) or aperture S/N")
    p.add_argument("key", nargs="?", default="barnards-star")
    p.add_argument("--snr", action="store_true", help="aperture S/N mode (faint targets)")
    p.add_argument("--det", default=None, help="detectors to stack, e.g. 6 or 5,6 (default: all)")

    m = sub.add_parser("motion", help="does the spot near the prediction move like the proper motion?")
    m.add_argument("key")
    m.add_argument("--det", default=None, help="detectors to stack, e.g. 5,6 (default: all)")
    m.add_argument("--fov", type=float, default=FOV_ARCMIN, help="field of view in arcmin (default 6)")

    a = ap.parse_args(argv)
    if a.check == "predicted":
        run_predicted(a.key, snr_mode=a.snr, detectors=_detectors(a.det))
    else:
        run_motion(a.key, detectors=_detectors(a.det), fov_arcmin=a.fov)


if __name__ == "__main__":
    main()
