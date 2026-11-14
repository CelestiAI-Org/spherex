"""Display-quality rendering of the real SPHEREx stacks (no invented detail).

Everything here is a deterministic transformation of the measured pixels:
  * LayerSet   - every usable cutout reprojected ONCE onto the pipeline's common grid (same helpers and
                 grid as science.pipeline.build_frames), kept UNSCALED so a stretch can be chosen freely.
  * stretch    - asinh stretch between a black and a white point shared by all frames of a target.
  * upscale    - Lanczos resampling (interpolation only; it adds no information).
"""
import warnings

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.wcs.utils import proj_plane_pixel_scales
import io

from PIL import Image
from reproject import reproject_interp

from api import bands as band_table
from science import pipeline  # helpers only; its logic is not changed

UPSCALE = 6                       # large PNGs are 6x the native grid
BLACK_PCT, WHITE_PCT = 1.0, 99.95  # percentiles of the pooled pixels of all frames that share a scale
# (99.7 clipped Barnard's Star to a flat white disc; 99.95 keeps shading in the core)
CHANNELS = {"blue": (1, 2), "green": (3, 4), "red": (5, 6)}   # detectors -> colour channel (short -> long)


def fill_small_holes(img, max_area=80, iterations=8):
    """Fill NaN pixels that form small holes completely enclosed by valid data (masked cores of bright stars,
    dead pixels) with the mean of their valid neighbours, applied repeatedly from the rim inwards.

    This is plain interpolation across flagged pixels; NaN regions that touch the image border (the empty
    corners of rotated cutouts) or are larger than max_area pixels are left as they are."""
    img = np.array(img, dtype=float)
    nan = ~np.isfinite(img)
    if not nan.any():
        return img
    H, W = img.shape
    seen = np.zeros_like(nan)
    hole = np.zeros_like(nan)
    for y0, x0 in zip(*np.nonzero(nan)):
        if seen[y0, x0]:
            continue
        stack, comp, touches = [(y0, x0)], [], False
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            touches |= y in (0, H - 1) or x in (0, W - 1)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and nan[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    stack.append((yy, xx))
        if not touches and len(comp) <= max_area:
            for y, x in comp:
                hole[y, x] = True
    for _ in range(iterations):
        todo = hole & ~np.isfinite(img)
        if not todo.any():
            break
        padded = np.pad(img, 1, constant_values=np.nan)
        neigh = np.stack([padded[1 + dy:1 + dy + H, 1 + dx:1 + dx + W] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(neigh, axis=0)
        fill = todo & np.isfinite(mean)
        img[fill] = mean[fill]
    return img


class LayerSet:
    """All usable cutouts of a target on the common grid. layers[i] pairs with meta[i]."""

    def __init__(self, cutouts, ra, dec, fov_arcmin):
        center = SkyCoord(ra * u.deg, dec * u.deg)
        usable = pipeline._usable(cutouts, center)
        if not usable:
            raise ValueError("no usable cutout")
        pixel_arcsec = float(np.mean(proj_plane_pixel_scales(usable[0].wcs)) * 3600)
        self.wcs_out, self.shape = pipeline._common_wcs(ra, dec, fov_arcmin, pixel_arcsec / pipeline.OVERSAMPLE)
        self.epochs = pipeline._split_epochs(usable)           # same epoch split as build_frames
        self.layers, self.meta = [], []
        for e, group in enumerate(self.epochs):
            for c in group:
                self.layers.append(reproject_interp((pipeline._clean(c), c.wcs), self.wcs_out, shape_out=self.shape)[0])
                self.meta.append({"epoch": e, "detector": c.detector, "mjd": c.mjd, "wavelength_um": c.wavelength_um})
        self.layers = np.stack(self.layers)

    def stack(self, epoch=None, detectors=None):
        """Median stack of the layers matching an epoch and/or a set of detectors; (image, n_images, meta rows)."""
        idx = [i for i, m in enumerate(self.meta)
               if (epoch is None or m["epoch"] == epoch) and (detectors is None or m["detector"] in detectors)]
        if not idx:
            return None, 0, []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            return fill_small_holes(np.nanmedian(self.layers[idx], axis=0)), len(idx), [self.meta[i] for i in idx]


def stretch_scale(arrays, black_pct=BLACK_PCT, white_pct=WHITE_PCT):
    """(black, white, beta) from the pooled finite pixels of `arrays`: ONE scale for all of them.
    beta (the asinh softening) is 3 robust sigma of the sky noise, so noise stays linear and bright
    sources are compressed instead of clipped."""
    pix = np.concatenate([a[np.isfinite(a)].ravel() for a in arrays])
    black, white = np.percentile(pix, [black_pct, white_pct])
    sky = pix[pix < np.percentile(pix, 80)]
    sigma = 1.4826 * np.median(np.abs(sky - np.median(sky)))
    beta = max(3 * sigma, (white - black) * 1e-4)
    return float(black), float(white), float(beta)


def asinh_stretch(img, scale):
    """Map to 0..1 with an asinh curve; NaN (no data) -> 0."""
    black, white, beta = scale
    x = np.clip(img - black, 0, None)
    out = np.arcsinh(x / beta) / np.arcsinh((white - black) / beta)
    return np.nan_to_num(np.clip(out, 0, 1), nan=0.0)


def upscale(arr01, factor=UPSCALE):
    """Lanczos-resample a 0..1 array (2D, or HxWx3) to factor x its size -> uint8.

    Interpolation only: it makes the picture smooth, it does not add information. Done on float data
    before the 8-bit quantisation; Lanczos overshoot is clipped to 0..1."""
    arr01 = np.asarray(arr01, dtype=np.float32)
    chans = [arr01] if arr01.ndim == 2 else [arr01[..., i] for i in range(arr01.shape[2])]
    out = []
    for ch in chans:
        h, w = ch.shape
        big = np.asarray(Image.fromarray(np.ascontiguousarray(ch), mode="F").resize((w * factor, h * factor), Image.LANCZOS))
        out.append(to_uint8(big))
    return out[0] if arr01.ndim == 2 else np.stack(out, axis=-1)


def to_uint8(arr01):
    return (np.clip(np.asarray(arr01, dtype=float), 0, 1) * 255 + 0.5).astype(np.uint8)


def png_bytes(arr_uint8) -> bytes:
    """PNG for a 2D (grey) or HxWx3 (RGB) uint8 array."""
    img = Image.fromarray(np.ascontiguousarray(arr_uint8), mode="L" if arr_uint8.ndim == 2 else "RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def signed_asinh(d, white_pct=99.7):
    """Difference image -> 0..1 with 0.5 = no change; asinh on |d|, same softening idea as asinh_stretch."""
    finite = d[np.isfinite(d)]
    sigma = 1.4826 * np.median(np.abs(finite - np.median(finite)))
    white = np.percentile(np.abs(finite), white_pct)
    beta = max(3 * sigma, white * 1e-4)
    out = 0.5 + 0.5 * np.sign(d) * np.arcsinh(np.abs(d) / beta) / np.arcsinh(max(white, beta) / beta)
    return np.nan_to_num(np.clip(out, 0, 1), nan=0.5)


def channel_legend(meta):
    """{'blue': {'detectors': [1, 2], 'wavelength_um': [lo, hi]}, ...} from the wavelengths actually measured."""
    out = {}
    for name, dets in CHANNELS.items():
        waves = [m["wavelength_um"] for m in meta if m["detector"] in dets and m["wavelength_um"] is not None]
        out[name] = {"detectors": list(dets), "wavelength_um": [round(min(waves), 2), round(max(waves), 2)] if waves else None}
    return out


class Rendered:
    """Everything the endpoints serve for one target, as uint8 arrays (native + large) and raw stacks."""

    def __init__(self, layerset: LayerSet):
        L = layerset
        self.shape = L.shape
        self.channels = channel_legend(L.meta)
        # --- one frame per epoch, ONE shared stretch for all epochs (so visits are comparable)
        gray = [L.stack(epoch=e) for e in range(len(L.epochs))]
        self.raw_epochs = [g[0] for g in gray]
        sc = stretch_scale(self.raw_epochs)
        ch_stacks = {c: [L.stack(epoch=e, detectors=CHANNELS[c])[0] for e in range(len(L.epochs))] for c in CHANNELS}
        ch_scales = {c: (stretch_scale([x for x in v if x is not None]) if any(x is not None for x in v) else None)
                     for c, v in ch_stacks.items()}
        self.epochs = []
        for e, (img, n, meta) in enumerate(gray):
            g = asinh_stretch(img, sc)
            mj = [m["mjd"] for m in meta]
            self.epochs.append({"n_images": n, "mjd_start": min(mj), "mjd_end": max(mj), "native": to_uint8(g),
                                "large": upscale(g),
                                "color": self._color({c: ch_stacks[c][e] for c in CHANNELS}, ch_scales)})
        # --- one frame per detector (all epochs), one shared stretch for the six detectors
        det = {d: L.stack(detectors=(d,)) for d in range(1, 7)}
        present = [v[0] for v in det.values() if v[0] is not None]
        dsc = stretch_scale(present) if present else None
        self.detectors = []
        for d, (img, n, meta) in det.items():
            waves = [m["wavelength_um"] for m in meta if m["wavelength_um"] is not None]
            entry = {"detector": d, "n_images": n, "channel": next(c for c, ds in CHANNELS.items() if d in ds),
                     "wavelength_range_um": [round(min(waves), 3), round(max(waves), 3)] if waves else None,
                     "native": None, "large": None}
            if img is not None:
                g = asinh_stretch(img, dsc)
                entry["native"], entry["large"] = to_uint8(g), upscale(g)
            self.detectors.append(entry)
        # --- false-colour composite of the whole data set (all epochs)
        allch = {c: L.stack(detectors=CHANNELS[c])[0] for c in CHANNELS}
        allsc = {c: (stretch_scale([v]) if v is not None else None) for c, v in allch.items()}
        self.color_all = self._color(allch, allsc)

    @staticmethod
    def _color(stacks, scales):
        """Large RGB uint8 from per-channel stacks (None = channel has no data); None if no channel has data."""
        if all(v is None for v in stacks.values()):
            return None
        shape = next(v.shape for v in stacks.values() if v is not None)
        chans = {c: (asinh_stretch(v, scales[c]) if v is not None else np.zeros(shape)) for c, v in stacks.items()}
        return upscale(np.stack([chans["red"], chans["green"], chans["blue"]], axis=-1))


def render_target(cutouts, ra, dec, fov_arcmin) -> Rendered:
    return Rendered(LayerSet(cutouts, ra, dec, fov_arcmin))


def local_noise(img, lag=3):
    """Pixel-to-pixel noise (robust): MAD of differences between pixels `lag` apart, / sqrt(2).
    Insensitive to smooth sky gradients and (mostly) to stars, unlike the spread of the sky pixels. The grid is
    2x oversampled so neighbouring pixels are correlated; lag=3 keeps that small, but it still slightly
    underestimates the noise per native pixel."""
    d = (img[:, lag:] - img[:, :-lag])
    d = d[np.isfinite(d)]
    return float(1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)) if d.size > 100 else None


def render_bands(L: LayerSet) -> dict:
    """One stacked, stretched, upscaled image per SPHEREx band (102), all epochs together.

    Same grid, hole filling, asinh stretch and Lanczos upscale as the other images; ONE stretch is shared by
    every band of the target so brightness changes along the slider are real. Exposures whose wavelength is
    outside every channel of their detector are left out (n_unassigned)."""
    groups, unassigned = {}, 0
    for i, m in enumerate(L.meta):
        b = band_table.assign(m["detector"], m["wavelength_um"])
        if b is None:
            unassigned += 1
        else:
            groups.setdefault(b, []).append(i)
    raw = {}
    for b, idx in groups.items():
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            img = fill_small_holes(np.nanmedian(L.layers[idx], axis=0))
        if np.isfinite(img).mean() >= 0.05:                       # basically empty -> treated as no data
            raw[b] = (img, [L.meta[i]["wavelength_um"] for i in idx], len(idx))
    sc = stretch_scale([v[0] for v in raw.values()]) if raw else None
    out = []
    for c in band_table.CHANNELS:
        entry = {**c, "n_images": 0, "measured_wavelength_um": None, "image": None, "native": None, "noise": None,
                 "nodata_fraction": None, "quality": None, "quality_notes": []}
        b = c["band_index"]
        if b in raw:
            img, waves, n = raw[b]
            g = asinh_stretch(img, sc)
            entry.update(n_images=n, measured_wavelength_um=[round(min(waves), 4), round(max(waves), 4)],
                         image=upscale(g), native=to_uint8(g), noise=local_noise(img),
                         nodata_fraction=float((~np.isfinite(img)).mean()))
        elif b in groups:
            entry["n_images"] = len(groups[b])
        out.append(entry)
    # quality flags, relative to this target's own typical band (so they work for faint and bright targets)
    have = [e for e in out if e["image"] is not None]
    if have:
        med_noise = float(np.median([e["noise"] for e in have if e["noise"]]))
        med_nodata = float(np.median([e["nodata_fraction"] for e in have]))
        for e in have:
            if e["n_images"] == 1:
                e["quality_notes"].append("single image")
            if e["noise"] and e["noise"] > 3 * med_noise:
                e["quality_notes"].append("noisy (pixel noise > 3x this target's median band)")
            if e["nodata_fraction"] > med_nodata + 0.15:
                e["quality_notes"].append("large missing-data area")
            e["quality"] = "low" if e["quality_notes"] else "ok"
    return {"bands": out, "n_unassigned": unassigned, "scale": sc, "shape": L.shape,
            "median_noise": med_noise if have else None}


def webp_bytes(arr_uint8, quality=85) -> bytes:
    img = Image.fromarray(np.ascontiguousarray(arr_uint8), mode="L")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()
