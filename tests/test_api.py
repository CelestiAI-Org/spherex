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


def test_static_fallback_serves_frames_and_diffs(client, tmp_path, monkeypatch):
    """With no cutout cache, /frames and /diff are served from static_export/."""
    import json
    import api.main as m
    key = "barnards-star"
    (tmp_path / key).mkdir()
    (tmp_path / key / "frames.json").write_text(json.dumps({"target": key, "frames": [], "diffs": []}))
    (tmp_path / key / "diff_0_1.png").write_bytes(b"PNGDATA")
    monkeypatch.setattr(m, "STATIC_EXPORT_DIR", tmp_path)
    monkeypatch.setattr(m, "load_index", lambda k: [])
    assert client.get("/frames", params=BARNARD).json()["target"] == key
    assert client.get("/diff", params={**BARNARD, "a": 0, "b": 1}).content == b"PNGDATA"
    assert client.get("/diff", params={**BARNARD, "a": 0, "b": 2}).status_code == 404


def test_nearest_match_within_10_arcmin(client):
    near = client.get("/frames", params={"ra": 269.55, "dec": 4.69, "fov": 5})  # ~6 arcmin from Barnard's J2000 position
    assert near.status_code == 200 and near.json()["target"] == "barnards-star"
    assert 5 < near.json()["matched_distance_arcmin"] < 10


def test_too_far_gives_json_error(client):
    r = client.get("/frames", params={"ra": 269.45, "dec": 5.5})  # ~50 arcmin away
    assert r.status_code == 404 and r.headers["content-type"] == "application/json"
    body = r.json()
    assert "error" in body and body["nearest"]["key"] == "barnards-star" and "barnards-star" in body["available_targets"]
    assert client.get("/frames").status_code == 400 and "error" in client.get("/frames").json()


def test_frames_by_target_name(client):
    assert client.get("/frames", params={"target": "barnards-star", "fov": 5}).json()["target"] == "barnards-star"
    assert client.get("/frames", params={"target": "nope"}).status_code == 404


def test_targets_listing(client):
    rows = {r["key"]: r for r in client.get("/targets").json()}
    b = rows["barnards-star"]
    assert b["name"] == "Barnard's Star" and b["visits"] == 3 and "ra" in b and b["frames_url"] == "/frames?target=barnards-star"


def test_prefer_static_skips_cutout_processing(client, tmp_path, monkeypatch):
    import json
    import api.main as m
    (tmp_path / "barnards-star").mkdir()
    (tmp_path / "barnards-star" / "frames.json").write_text(json.dumps({"target": "barnards-star", "frames": [1, 2, 3, 4], "diffs": []}))
    monkeypatch.setattr(m, "STATIC_EXPORT_DIR", tmp_path)
    monkeypatch.setattr(m, "PREFER_STATIC", True)
    monkeypatch.setattr(m, "compute_frames", lambda *a: (_ for _ in ()).throw(AssertionError("should not stack cutouts")))
    assert len(client.get("/frames", params={"target": "barnards-star"}).json()["frames"]) == 4
    assert {r["key"]: r for r in client.get("/targets").json()}["barnards-star"]["visits"] == 4
