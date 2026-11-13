"""Write realistic FAKE cutouts into the real cache layout as target "fake_mover".

    python scripts/make_fake_cutouts.py

For testing build_frames without IRSA. Layout matches CACHE.md, so
`load_cutouts("fake_mover")` works exactly like it will for real targets.

What is simulated (SPHEREx-like: 6.2" pixels, ~2.6 px FWHM PSF):
  * 3 visits ~180 days apart, 5-8 cutouts each, taken within ~2 days
  * every cutout has its own WCS: small pointing offset (+-3 px) and rotation (+-2 deg)
  * a zodiacal background in the ZODI extension (IMAGE = sky + ZODI), plus Gaussian noise
  * 5-10 bad pixels per cutout, set to garbage values and marked in FLAGS
  * 20-30 fixed background stars
  * one star ("mover") that moves 2.5 px per visit toward position angle 60 deg
    (60 deg east of north). True positions are in cache/fake_mover/truth.json
"""
import json
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.load_cache import CACHE_DIR  # noqa: E402
from api.targets import TARGETS  # noqa: E402

KEY = "fake_mover"
PIX_ARCSEC = 6.2
SIZE = 64                  # cutout is SIZE x SIZE pixels (~6.6 arcmin)
FOV_ARCMIN = 6.0           # field the API will request
VISIT_MJD = [60900.0, 61080.0, 61260.0]   # ~180 days apart
MOVER_STEP_PX = 2.5
MOVER_PA_DEG = 60.0        # position angle: degrees east of north
PSF_SIGMA = 1.1            # px  (FWHM ~2.6 px)
BAD_FLAG = 1 << 6


def sky_offset(ra0, dec0, east_px, north_px):
    """Sky position displaced by (east, north) pixels from (ra0, dec0)."""
    de, dn = east_px * PIX_ARCSEC / 3600, north_px * PIX_ARCSEC / 3600
    return ra0 + de / np.cos(np.radians(dec0)), dec0 + dn


def make_wcs(ra0, dec0, off_x_px, off_y_px, rot_deg):
    c, s = np.cos(np.radians(rot_deg)), np.sin(np.radians(rot_deg))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [SIZE / 2 + off_x_px, SIZE / 2 + off_y_px]
    w.wcs.cdelt = [-PIX_ARCSEC / 3600, PIX_ARCSEC / 3600]
    w.wcs.pc = [[c, -s], [s, c]]
    return w


def add_star(img, x, y, flux):
    r = int(5 * PSF_SIGMA) + 1
    x0, y0 = int(round(x)), int(round(y))
    ys, xs = np.mgrid[max(y0 - r, 0):min(y0 + r + 1, SIZE), max(x0 - r, 0):min(x0 + r + 1, SIZE)]
    if ys.size:
        img[ys, xs] += flux / (2 * np.pi * PSF_SIGMA ** 2) * np.exp(-((xs - x) ** 2 + (ys - y) ** 2) / (2 * PSF_SIGMA ** 2))


def main():
    rng = np.random.default_rng(42)
    t = TARGETS[KEY]
    ra0, dec0 = t["ra"], t["dec"]
    out = CACHE_DIR / KEY
    (out / "cutouts").mkdir(parents=True, exist_ok=True)
    for old in (out / "cutouts").glob("*.fits"):
        old.unlink()

    # fixed stars: offsets from the field centre in pixels (kept clear of the edges)
    n_stars = int(rng.integers(20, 31))
    stars = []
    for _ in range(n_stars):
        e, n = rng.uniform(-24, 24, 2)
        ra, dec = sky_offset(ra0, dec0, e, n)
        stars.append({"ra": float(ra), "dec": float(dec), "flux": float(10 ** rng.uniform(2.0, 3.3))})
    mover_flux = 1500.0
    start_e, start_n = -8.0, -6.0   # visit-0 offset from centre (px)
    step_e, step_n = MOVER_STEP_PX * np.sin(np.radians(MOVER_PA_DEG)), MOVER_STEP_PX * np.cos(np.radians(MOVER_PA_DEG))

    index, truth_cutouts, truth_mover = [], [], []
    for v, mjd0 in enumerate(VISIT_MJD):
        mra, mdec = sky_offset(ra0, dec0, start_e + v * step_e, start_n + v * step_n)
        truth_mover.append({"visit": v, "mjd": mjd0, "ra": float(mra), "dec": float(mdec)})
        for k in range(int(rng.integers(5, 9))):
            ox, oy, rot = rng.uniform(-3, 3), rng.uniform(-3, 3), rng.uniform(-2, 2)
            w = make_wcs(ra0, dec0, ox, oy, rot)
            sky = np.zeros((SIZE, SIZE))
            for s in stars:
                x, y = w.all_world2pix(s["ra"], s["dec"], 0)
                add_star(sky, float(x), float(y), s["flux"])
            mx, my = (float(a) for a in w.all_world2pix(mra, mdec, 0))
            add_star(sky, mx, my, mover_flux)

            yy, xx = np.mgrid[:SIZE, :SIZE]
            zodi = 60 + 0.05 * xx + 0.03 * yy + rng.normal(0, 0.5)   # smooth background level
            image = sky + zodi + rng.normal(0, 1.5, (SIZE, SIZE))
            flags = np.zeros((SIZE, SIZE), dtype=np.int32)
            for _ in range(int(rng.integers(5, 11))):
                bx, by = rng.integers(0, SIZE, 2)
                flags[by, bx] = BAD_FLAG
                image[by, bx] = rng.choice([-1, 1]) * rng.uniform(300, 3000)

            mjd = mjd0 + float(rng.uniform(0, 2))
            det = int(rng.integers(1, 7))
            hdr = w.to_header()
            hdr["MJD-AVG"] = mjd
            hdr["DETECTOR"] = det
            name = f"fake_v{v}_{k}_D{det}.fits"
            fits.HDUList([fits.PrimaryHDU(),
                          fits.ImageHDU(image.astype(np.float32), hdr, name="IMAGE"),
                          fits.ImageHDU(flags, name="FLAGS"),
                          fits.ImageHDU(zodi.astype(np.float32), name="ZODI")]).writeto(out / "cutouts" / name, overwrite=True)
            index.append({"file": name, "mjd": mjd, "detector": det})
            truth_cutouts.append({"file": name, "visit": v, "mjd": mjd, "offset_px": [ox, oy], "rotation_deg": rot,
                                  "mover_pixel_xy": [mx, my]})

    (out / "index.json").write_text(json.dumps({"fov_arcmin": FOV_ARCMIN, "cutouts": index}, indent=1))
    (out / "truth.json").write_text(json.dumps({
        "note": "FAKE data. Pixel coords are 0-based (x=column, y=row) in each cutout's own WCS.",
        "pixel_scale_arcsec": PIX_ARCSEC, "cutout_size_px": SIZE,
        "mover": {"motion_px_per_visit": MOVER_STEP_PX, "position_angle_deg_east_of_north": MOVER_PA_DEG,
                  "flux": mover_flux, "positions": truth_mover},
        "stars": stars, "cutouts": truth_cutouts}, indent=1))
    per_visit = [sum(1 for c in truth_cutouts if c["visit"] == v) for v in range(3)]
    print(f"wrote {len(index)} cutouts {per_visit} per visit, {n_stars} stars -> {out}")


if __name__ == "__main__":
    main()
