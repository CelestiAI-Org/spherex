import io

import numpy as np
from PIL import Image

from science.types import Frame

BARNARD = dict(ra=269.4521, dec=4.6934)  # catalogue (J2000) position; cache is centred on the 2026 position


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert "barnards-star" in r.json()["cached_targets"]


def test_resolve_known(client):
    r = client.get("/resolve", params={"name": "Barnard's Star"})
    assert r.status_code == 200
    assert abs(r.json()["ra"] - 269.4521) < 0.01


def test_frames_and_images(client):
    r = client.get("/frames", params={**BARNARD, "fov": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["pipeline"] == "fallback"
    assert len(body["frames"]) == 3
    assert body["frames"][0]["n_images"] == 2
    img = client.get(body["frames"][0]["url"])
    assert img.status_code == 200
    assert Image.open(io.BytesIO(img.content)).size == (128, 128)


def test_frames_unknown_location_404(client):
    assert client.get("/frames", params={"ra": 10, "dec": 10}).status_code == 404


def test_diff_png(client):
    r = client.get("/diff", params={**BARNARD, "fov": 5, "a": 0, "b": 2})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert client.get("/diff", params={**BARNARD, "a": 0, "b": 99}).status_code == 404


def test_frames_switch_to_science_pipeline(client, monkeypatch):
    """When Futa implements build_frames, /frames must use it with no API changes."""
    from science import pipeline
    calls = []

    def fake_build_frames(cutouts, ra, dec, fov):
        calls.append(len(cutouts))
        return [Frame(image=np.full((16, 16), 0.5), mjd_start=1.0, mjd_end=2.0, n_images=len(cutouts))]

    monkeypatch.setattr(pipeline, "build_frames", fake_build_frames)
    from api.main import compute_frames
    compute_frames.cache_clear()
    body = client.get("/frames", params={**BARNARD, "fov": 4.5}).json()
    assert calls, "fake build_frames was never called"
    assert body["pipeline"] == "science.pipeline"
    assert len(body["frames"]) == 1 and body["frames"][0]["n_images"] == 6
    assert client.get("/health").json()["pipeline"] == "science.pipeline"
    compute_frames.cache_clear()


def test_pipeline_crash_falls_back(client, monkeypatch):
    from science import pipeline
    from api.main import compute_frames

    def boom(*a, **k):
        raise ValueError("bug in science code")

    monkeypatch.setattr(pipeline, "build_frames", boom)
    compute_frames.cache_clear()
    body = client.get("/frames", params={**BARNARD, "fov": 4.2}).json()
    assert body["pipeline"] == "fallback" and len(body["frames"]) == 3
    compute_frames.cache_clear()
