"""SPHEREx time-lapse API.

    uvicorn api.main:app --port 8000

Cached data first, always: requests never trigger a live download.
"""
import json
import logging
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api import fallback  # noqa: E402
from api.load_cache import CACHE_DIR, load_cutouts, load_index, target_dir  # noqa: E402
from api.targets import DEFAULT_FOV_ARCMIN, TARGETS, find_by_coords, find_by_name  # noqa: E402
from science import pipeline  # noqa: E402

log = logging.getLogger("api")
RENDER_DIR = CACHE_DIR / "rendered"
STATIC_EXPORT_DIR = ROOT / "static_export"

app = FastAPI(title="SPHEREx time-lapse API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
RENDER_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/img", StaticFiles(directory=RENDER_DIR), name="img")


# ---------- science plug-in point ----------

def build_frames(cutouts, ra, dec, fov):
    """Use science.pipeline.build_frames if Futa has implemented it, else the fallback.

    Looked up at call time, so the switch happens as soon as the stub is replaced.
    Any failure in the real pipeline also falls back, so the demo never breaks.
    """
    try:
        return pipeline.build_frames(cutouts, ra, dec, fov), "science.pipeline"
    except NotImplementedError:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("science.pipeline.build_frames failed, using fallback: %s", e)
    return fallback.build_frames(cutouts, ra, dec, fov), "fallback"


def difference(a, b):
    try:
        return pipeline.difference(a, b), "science.pipeline"
    except NotImplementedError:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("science.pipeline.difference failed, using fallback: %s", e)
    return fallback.difference(a, b), "fallback"


# ---------- helpers ----------

def to_png_bytes(arr01: np.ndarray) -> bytes:
    import io
    img = Image.fromarray((np.clip(arr01, 0, 1) * 255).astype(np.uint8), mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def cached_fov(key: str) -> float:
    idx = target_dir(key) / "index.json"
    if idx.exists():
        return float(json.loads(idx.read_text()).get("fov_arcmin", DEFAULT_FOV_ARCMIN))
    return DEFAULT_FOV_ARCMIN


@lru_cache(maxsize=32)
def compute_frames(key: str, ra: float, dec: float, fov: float):
    """-> (frames, source). Cached in memory because cutout loading is the slow part."""
    cutouts = load_cutouts(key)
    if not cutouts:
        return [], "none"
    return build_frames(cutouts, ra, dec, fov)


def resolve_target(ra: float, dec: float):
    hit = find_by_coords(ra, dec)
    if not hit or not load_index(hit[0]):
        raise HTTPException(404, f"No cached data near ra={ra}, dec={dec}. "
                                 f"Cached targets: {[k for k in TARGETS if load_index(k)]}")
    return hit


# ---------- endpoints ----------

@app.get("/health")
def health():
    return {"status": "ok",
            "pipeline": "science.pipeline" if _pipeline_ready() else "fallback",
            "cached_targets": [k for k in TARGETS if load_index(k)]}


def _pipeline_ready() -> bool:
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
        raise HTTPException(404, f"Could not resolve '{name}'")
    return {"name": name, "key": None, "ra": float(c.ra.deg), "dec": float(c.dec.deg),
            "source": "sesame", "cached": False}


@app.get("/frames")
def frames(ra: float, dec: float, fov: float = Query(DEFAULT_FOV_ARCMIN, gt=0, le=60)):
    key, target = resolve_target(ra, dec)
    fov = min(fov, cached_fov(key))
    frs, source = compute_frames(key, round(target["ra"], 5), round(target["dec"], 5), round(fov, 3))
    if not frs:
        raise HTTPException(404, f"Cached cutouts for {key} contain no coverage of this field")
    out_dir = RENDER_DIR / key / f"fov{fov:g}"
    out_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for i, f in enumerate(frs):
        (out_dir / f"{i}.png").write_bytes(to_png_bytes(f.image))
        items.append({"index": i, "url": f"/img/{key}/fov{fov:g}/{i}.png",
                      "mjd_start": f.mjd_start, "mjd_end": f.mjd_end, "n_images": f.n_images})
    return {"target": key, "name": target["name"], "ra": target["ra"], "dec": target["dec"],
            "fov_arcmin": fov, "pipeline": source, "frames": items}


@app.get("/diff")
def diff(ra: float, dec: float, a: int, b: int, fov: float = Query(DEFAULT_FOV_ARCMIN, gt=0, le=60)):
    """PNG difference of frames a and b (grey = no change, bright/dark = brighter/fainter in b)."""
    key, target = resolve_target(ra, dec)
    fov = min(fov, cached_fov(key))
    frs, _ = compute_frames(key, round(target["ra"], 5), round(target["dec"], 5), round(fov, 3))
    for idx in (a, b):
        if not 0 <= idx < len(frs):
            raise HTTPException(404, f"Frame {idx} does not exist; there are {len(frs)} frames")
    d, _ = difference(frs[a], frs[b])
    d = np.asarray(d, dtype=float)
    scale = np.nanpercentile(np.abs(d), 99.5) or 1.0
    return Response(to_png_bytes(0.5 + 0.5 * np.clip(d / scale, -1, 1)), media_type="image/png")
