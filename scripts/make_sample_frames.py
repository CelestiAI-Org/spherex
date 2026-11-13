"""Write api/sample_frames.json + api/sample_frames/*.png for the frontend team.

Uses the real cache for Barnard's Star if it exists; otherwise writes clearly
labelled PLACEHOLDER frames (synthetic star, not real SPHEREx data).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.load_cache import load_index  # noqa: E402
from api.targets import TARGETS  # noqa: E402

OUT_JSON = ROOT / "api" / "sample_frames.json"
OUT_DIR = ROOT / "api" / "sample_frames"


def real():
    from fastapi.testclient import TestClient
    from api.main import app
    t = TARGETS["barnards-star"]
    c = TestClient(app)
    body = c.get("/frames", params={"ra": t["ra"], "dec": t["dec"]}).json()
    for f in body["frames"]:
        (OUT_DIR / f"{f['index']}.png").write_bytes(c.get(f["url"]).content)
        f["url"] = f"/sample_frames/{f['index']}.png"
    body["placeholder"] = False
    return body


def placeholder():
    t = TARGETS["barnards-star"]
    rng = np.random.default_rng(1)
    y, x = np.mgrid[:128, :128]
    frames = []
    for i, mjd in enumerate([60000.0, 60180.0, 60360.0]):
        img = rng.normal(0.15, 0.03, (128, 128)) + np.exp(-((x - (50 + 14 * i)) ** 2 + (y - 64) ** 2) / 12)
        Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "L").save(OUT_DIR / f"{i}.png")
        frames.append({"index": i, "url": f"/sample_frames/{i}.png", "mjd_start": mjd, "mjd_end": mjd + 0.8, "n_images": 4})
    return {"target": "barnards-star", "name": t["name"], "ra": t["ra"], "dec": t["dec"], "fov_arcmin": 6.0,
            "pipeline": "placeholder", "placeholder": True, "frames": frames}


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    body = real() if load_index("barnards-star") else placeholder()
    OUT_JSON.write_text(json.dumps(body, indent=2))
    print(f"wrote {OUT_JSON} ({'PLACEHOLDER' if body['placeholder'] else 'real'} frames: {len(body['frames'])})")
