"""SPHEREx time-lapse API.

    uvicorn api.main:app --port 8000

Cached data first, always: requests never trigger a live download.
"""
import json
import logging
import os
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api import display, fallback, photometry  # noqa: E402
from api.load_cache import CACHE_DIR, load_cutouts, load_index, target_dir  # noqa: E402
from science.types import Frame  # noqa: E402
from api.targets import DEFAULT_FOV_ARCMIN, TARGETS, find_by_name, nearest  # noqa: E402
try:
    from science import pipeline  # noqa: E402
except Exception as _e:  # noqa: BLE001  (e.g. a missing dependency): the API must still start
    logging.getLogger("api").exception("science.pipeline could not be imported, using fallback only: %s", _e)
    pipeline = None

log = logging.getLogger("api")
RENDER_DIR = CACHE_DIR / "rendered"
STATIC_EXPORT_DIR = ROOT / "static_export"
MAX_MATCH_ARCMIN = 10.0  # a request matches the nearest cached target if it is within this distance
# On the deployed server, answer from the pre-rendered static_export even if raw cutouts are present:
# stacking hundreds of FITS cutouts per request is far too slow for a small instance.
PREFER_STATIC = os.environ.get("SPHEREX_PREFER_STATIC") == "1"

app = FastAPI(title="SPHEREx time-lapse API")


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        self.status, self.body = status, {"error": message, **extra}


@app.exception_handler(ApiError)
async def api_error_handler(request, exc: ApiError):
    return JSONResponse(exc.body, status_code=exc.status)


@app.exception_handler(Exception)
async def unexpected_error_handler(request, exc: Exception):
    log.exception("unhandled error on %s", request.url)
    return JSONResponse({"error": "internal server error", "detail": str(exc)[:200]}, status_code=500)


app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
RENDER_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/img", StaticFiles(directory=RENDER_DIR), name="img")
if STATIC_EXPORT_DIR.exists():  # offline backup: pre-rendered frames.json + PNGs (scripts/export_static.py)
    app.mount("/static", StaticFiles(directory=STATIC_EXPORT_DIR), name="static")


# ---------- science plug-in point ----------

def build_frames(cutouts, ra, dec, fov):
    """-> (frames, source, error). Uses science.pipeline.build_frames, else the fallback.

    Looked up at call time, so the switch happens as soon as the stub is replaced. ANY failure in the
    real pipeline (not implemented, exception, empty result) falls back, so the demo never breaks;
    `error` says why.
    """
    error = None
    try:
        if pipeline is None:
            raise NotImplementedError("science.pipeline not importable")
        frames = pipeline.build_frames(cutouts, ra, dec, fov)
        if frames:
            log.info("frames built by science.pipeline: %d frames from %d cutouts", len(frames), len(cutouts))
            return frames, "science.pipeline", None
        error = "science.pipeline returned no frames"
    except NotImplementedError:
        error = None  # not written yet - not an error
    except Exception as e:  # noqa: BLE001
        log.exception("science.pipeline.build_frames failed, using fallback: %s", e)
        error = f"{type(e).__name__}: {e}"[:200]
    frames = fallback.build_frames(cutouts, ra, dec, fov)
    log.info("frames built by fallback: %d frames from %d cutouts (%s)", len(frames), len(cutouts), error or "pipeline not implemented")
    return frames, "fallback", error


def difference(a, b):
    try:
        if pipeline is None:
            raise NotImplementedError
        return pipeline.difference(a, b), "science.pipeline"
    except NotImplementedError:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("science.pipeline.difference failed, using fallback: %s", e)
    return fallback.difference(a, b), "fallback"


# ---------- helpers ----------

def cached_fov(key: str) -> float:
    idx = target_dir(key) / "index.json"
    if idx.exists():
        return float(json.loads(idx.read_text()).get("fov_arcmin", DEFAULT_FOV_ARCMIN))
    return DEFAULT_FOV_ARCMIN


@lru_cache(maxsize=32)
def compute_frames(key: str, ra: float, dec: float, fov: float):
    """-> (frames, source, error). Cached in memory because cutout loading is the slow part."""
    cutouts = load_cutouts(key)
    if not cutouts:
        return [], "none", None
    return build_frames(cutouts, ra, dec, fov)


def static_frames(key: str):
    """Pre-rendered /frames response from static_export/, or None."""
    path = STATIC_EXPORT_DIR / key / "frames.json"
    return json.loads(path.read_text()) if path.exists() else None


def use_static(key: str) -> bool:
    has_static = (STATIC_EXPORT_DIR / key / "frames.json").exists()
    return has_static and (PREFER_STATIC or not load_index(key))


def available_keys() -> list[str]:
    return [k for k in TARGETS if load_index(k) or (STATIC_EXPORT_DIR / k / "frames.json").exists()]


def pick_target(ra, dec, target):
    """Return (key, target dict, distance_arcmin) from a target name or the nearest cached target to ra/dec."""
    keys = available_keys()
    if target:
        hit = find_by_name(target)
        if not hit or hit[0] not in keys:
            raise ApiError(404, f"Unknown or uncached target '{target}'", available_targets=keys)
        return hit[0], hit[1], 0.0
    if ra is None or dec is None:
        raise ApiError(400, "Give either ?target=<key> or both ?ra= and ?dec=", available_targets=keys)
    near = nearest(ra, dec, keys)
    if near is None or near[2] > MAX_MATCH_ARCMIN:
        raise ApiError(404, f"No cached target within {MAX_MATCH_ARCMIN:g} arcmin of ra={ra}, dec={dec}",
                       nearest=({"key": near[0], "name": near[1]["name"], "distance_arcmin": round(near[2], 1)} if near else None),
                       available_targets=keys)
    return near


# ---------- endpoints ----------

@app.get("/health")
def health():
    return {"status": "ok",
            "pipeline": "science.pipeline" if _pipeline_ready() else "fallback",
            "cached_targets": [k for k in TARGETS if load_index(k)],
            "static_targets": [k for k in TARGETS if (STATIC_EXPORT_DIR / k / "frames.json").exists()],
            "prefer_static": PREFER_STATIC}


def _pipeline_ready() -> bool:
    if pipeline is None:
        return False
    try:
        pipeline.build_frames([], 0.0, 0.0, 1.0)
    except NotImplementedError:
        return False
    except Exception:  # noqa: BLE001  (implemented, just doesn't like empty input)
        pass
    return True


@app.get("/resolve")
def resolve(name: str):
    """Name -> coordinates. Known targets are answered from our table; others via CDS Sesame."""
    hit = find_by_name(name)
    if hit:
        key, t = hit
        return {"name": t["name"], "key": key, "ra": t["ra"], "dec": t["dec"], "source": "table",
                "cached": bool(load_index(key))}
    try:
        from astropy.coordinates import SkyCoord
        c = SkyCoord.from_name(name)
    except Exception:  # noqa: BLE001
        raise ApiError(404, f"Could not resolve '{name}'")
    return {"name": name, "key": None, "ra": float(c.ra.deg), "dec": float(c.dec.deg),
            "source": "sesame", "cached": False}


@app.get("/targets")
def targets():
    """Every cached target with name, coordinates and visit count (use `target=<key>` in /frames)."""
    out = []
    for key in available_keys():
        t = TARGETS[key]
        if use_static(key):
            visits, source = len(static_frames(key)["frames"]), "static"
        else:
            visits, source = fallback.count_visits([r["mjd"] for r in load_index(key)]), "cache"
        out.append({"key": key, "name": t["name"], "ra": t["ra"], "dec": t["dec"], "visits": visits,
                    "source": source, "frames_url": f"/frames?target={key}"})
    return out


@lru_cache(maxsize=8)
def display_for(key: str, ra: float, dec: float, fov: float):
    """Display-quality rendering (asinh stretch, Lanczos upscale, colour) of a target, or None if it fails."""
    try:
        return display.render_target(load_cutouts(key), ra, dec, fov)
    except Exception as e:  # noqa: BLE001  (the plain frames still work without it)
        log.exception("display rendering failed for %s: %s", key, e)
        return None


@app.get("/frames")
def frames(ra: float | None = None, dec: float | None = None, target: str | None = None,
           fov: float = Query(DEFAULT_FOV_ARCMIN, gt=0, le=60)):
    """Frames for the cached target nearest to (ra, dec) (within 10 arcmin), or for `target=<key>`.

    Each frame has `url` / `png_url_large` (6x Lanczos, asinh stretch shared by all frames), `png_url_native`
    (same stretch, native pixels) and `png_url_color` (false-colour composite of that visit, or null).
    """
    key, t, dist = pick_target(ra, dec, target)
    if use_static(key):  # pre-rendered; `fov` is ignored
        return {**static_frames(key), "matched_distance_arcmin": round(dist, 2)}
    fov = min(fov, cached_fov(key))
    ra_c, dec_c, fov_c = round(t["ra"], 5), round(t["dec"], 5), round(fov, 3)
    frs, source, error = compute_frames(key, ra_c, dec_c, fov_c)
    if not frs:
        raise ApiError(404, f"Cached cutouts for {key} contain no coverage of this field")
    rend = display_for(key, ra_c, dec_c, fov_c) if source == "science.pipeline" else None
    if rend and (len(rend.epochs) != len(frs) or [e["n_images"] for e in rend.epochs] != [f.n_images for f in frs]):
        rend = None  # grouping differs from the pipeline's frames: do not mix them
    base = f"/img/{key}/fov{fov:g}"
    out_dir = RENDER_DIR / key / f"fov{fov:g}"
    out_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for i, f in enumerate(frs):
        if rend:
            native, large, color = rend.epochs[i]["native"], rend.epochs[i]["large"], rend.epochs[i]["color"]
        else:  # plain frames from the pipeline/fallback: same Lanczos upscale, their own (linear) scaling
            native, large, color = display.to_uint8(f.image), display.upscale(f.image), None
        (out_dir / f"{i}.png").write_bytes(display.png_bytes(large))
        (out_dir / f"{i}_native.png").write_bytes(display.png_bytes(native))
        if color is not None:
            (out_dir / f"{i}_color.png").write_bytes(display.png_bytes(color))
        items.append({"index": i, "url": f"{base}/{i}.png", "png_url_large": f"{base}/{i}.png",
                      "png_url_native": f"{base}/{i}_native.png",
                      "png_url_color": f"{base}/{i}_color.png" if color is not None else None,
                      "mjd_start": f.mjd_start, "mjd_end": f.mjd_end, "n_images": f.n_images})
    out = {"target": key, "name": t["name"], "ra": t["ra"], "dec": t["dec"], "fov_arcmin": fov,
           "pipeline": source, "matched_distance_arcmin": round(dist, 2),
           "frame_shape": list(frs[0].image.shape), "large_shape": list(large.shape[:2]), "upscale": display.UPSCALE,
           "stretch": ({"type": "asinh", "black_percentile": display.BLACK_PCT, "white_percentile": display.WHITE_PCT,
                        "shared_across_frames": True} if rend else {"type": "linear (pipeline scaling)"}),
           "color_channels": rend.channels if rend else None, "frames": items}
    if error:
        out["pipeline_error"] = error  # why science.pipeline was not used
    return out


@app.get("/diff")
def diff(a: int, b: int, ra: float | None = None, dec: float | None = None, target: str | None = None,
         fov: float = Query(DEFAULT_FOV_ARCMIN, gt=0, le=60)):
    """PNG difference of frames a and b, 6x Lanczos (mid-grey = no change, bright = brighter in b)."""
    key, t, _ = pick_target(ra, dec, target)
    if use_static(key):  # pre-rendered differences between consecutive frames only
        path = STATIC_EXPORT_DIR / key / f"diff_{a}_{b}.png"
        if not path.exists():
            raise ApiError(404, "This server only has pre-rendered differences between consecutive frames (b = a + 1)")
        return Response(path.read_bytes(), media_type="image/png")
    fov = min(fov, cached_fov(key))
    ra_c, dec_c, fov_c = round(t["ra"], 5), round(t["dec"], 5), round(fov, 3)
    frs, source, _ = compute_frames(key, ra_c, dec_c, fov_c)
    for idx in (a, b):
        if not 0 <= idx < len(frs):
            raise ApiError(404, f"Frame {idx} does not exist; there are {len(frs)} frames")
    rend = display_for(key, ra_c, dec_c, fov_c) if source == "science.pipeline" else None
    if rend and len(rend.epochs) == len(frs):
        # difference of the UNCLIPPED stacks (the 0-1 frames have clipped stars), through the pipeline's difference()
        fa, fb = (Frame(image=rend.raw_epochs[i], mjd_start=frs[i].mjd_start, mjd_end=frs[i].mjd_end,
                        n_images=frs[i].n_images) for i in (a, b))
        d, _ = difference(fa, fb)
        shown = display.signed_asinh(np.asarray(d, dtype=float))
    else:
        d, _ = difference(frs[a], frs[b])
        d = np.asarray(d, dtype=float)
        scale = np.nanpercentile(np.abs(d), 99.5) or 1.0
        shown = 0.5 + 0.5 * np.clip(d / scale, -1, 1)
    return Response(display.png_bytes(display.upscale(shown)), media_type="image/png")


@app.get("/spectrum")
def spectrum(ra: float | None = None, dec: float | None = None, target: str | None = None,
             exclude_saturated: bool = False):
    """Flux vs wavelength of the target: aperture photometry in every cutout that contains it.

    `spectrum` is sorted by wavelength; each point has wavelength_um, flux (Jy), flux_err (Jy, statistical
    only), detector, mjd, saturated (core pixels flagged OVERFLOW: flux is then a biased-low lower limit).
    """
    key, t, _ = pick_target(ra, dec, target)
    if use_static(key):
        path = STATIC_EXPORT_DIR / key / "spectrum.json"
        if not path.exists():
            raise ApiError(404, f"No pre-computed spectrum for {key}")
        out = json.loads(path.read_text())
    else:
        out = dict(photometry.spectrum(key))
    if exclude_saturated:
        out["spectrum"] = [p for p in out["spectrum"] if not p["saturated"]]
        out["n_points"] = len(out["spectrum"])
    return out


@app.get("/frames_by_detector")
def frames_by_detector(ra: float | None = None, dec: float | None = None, target: str | None = None,
                       fov: float = Query(DEFAULT_FOV_ARCMIN, gt=0, le=60)):
    """One stacked frame per detector (1-6, all epochs) on one shared asinh stretch, plus a false-colour
    composite (`png_url_color`; `color_channels` says which detectors/wavelengths are blue, green, red).
    Each detector has `channel`, `wavelength_range_um`, `png_url` (6x Lanczos) and `png_url_native`.
    A detector without usable data has `png_url: null` and a `note`."""
    key, t, _ = pick_target(ra, dec, target)
    if use_static(key):
        path = STATIC_EXPORT_DIR / key / "detectors.json"
        if not path.exists():
            raise ApiError(404, f"No pre-computed detector frames for {key}")
        return json.loads(path.read_text())
    fov = min(fov, cached_fov(key))
    rend = display_for(key, round(t["ra"], 5), round(t["dec"], 5), round(fov, 3))
    if rend is None:
        raise ApiError(503, f"Could not build the detector frames for {key} (no usable cutouts)")
    base = f"/img/{key}/detectors"
    out_dir = RENDER_DIR / key / "detectors"
    out_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for e in rend.detectors:
        item = {k: v for k, v in e.items() if k not in ("native", "large")}
        item["png_url"] = item["png_url_native"] = None
        if e["large"] is not None:
            d = e["detector"]
            (out_dir / f"det{d}.png").write_bytes(display.png_bytes(e["large"]))
            (out_dir / f"det{d}_native.png").write_bytes(display.png_bytes(e["native"]))
            item["png_url"], item["png_url_native"] = f"{base}/det{d}.png", f"{base}/det{d}_native.png"
        else:
            item["note"] = "no usable cutout for this detector (target outside the images or too many bad pixels)"
        items.append(item)
    color_url = None
    if rend.color_all is not None:
        (out_dir / "color.png").write_bytes(display.png_bytes(rend.color_all))
        color_url = f"{base}/color.png"
    return {"target": key, "name": t["name"], "ra": t["ra"], "dec": t["dec"], "fov_arcmin": fov,
            "frame_shape": list(rend.shape), "large_shape": [rend.shape[0] * display.UPSCALE, rend.shape[1] * display.UPSCALE],
            "upscale": display.UPSCALE, "shared_scale": True, "stretch": "asinh, 1st-99.95th percentile, shared by all detectors",
            "png_url_color": color_url, "color_channels": rend.channels, "detectors": items}
