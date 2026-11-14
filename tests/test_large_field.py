"""The 15' (large) cutout cache: preferred automatically, ~1024 px WebP output, shapes reported correctly."""
import io

import numpy as np
import pytest
from PIL import Image

from tests.conftest import STAR_SUM, make_fake_cache

T = {"target": "barnards-star"}


@pytest.fixture()
def large_cache(tmp_path, monkeypatch):
    """A 15' fake cache for barnards-star in a temp cache_large/, active for the test."""
    import api.load_cache as lc
    import api.main as m
    from api import photometry
    make_fake_cache(tmp_path, fov=15.0)
    monkeypatch.setattr(lc, "CACHE_LARGE_DIR", tmp_path)
    for fn in (m.compute_frames, m.display_for, m.layerset_for, m.bands_for, photometry.spectrum):
        fn.cache_clear()
    yield tmp_path
    for fn in (m.compute_frames, m.display_for, m.layerset_for, m.bands_for, photometry.spectrum):
        fn.cache_clear()


def test_large_cache_is_preferred_and_shapes_are_right(client, large_cache):
    body = client.get("/frames", params=T).json()
    assert body["fov_arcmin"] == 15.0                           # default = the cached field, not 6'
    h, w = body["frame_shape"]
    assert h == w and 280 <= h <= 300                           # 15' at ~3.1"/px
    assert body["image_format"] == "webp" and abs(body["large_shape"][0] - 1024) <= 1 and body["large_shape"][0] == body["large_shape"][1]
    f0 = body["frames"][0]
    for field, size in (("png_url_large", tuple(body["large_shape"][::-1])), ("png_url_native", (w, h)), ("png_url_color", tuple(body["large_shape"][::-1]))):
        assert f0[field].endswith(".webp")
        im = Image.open(io.BytesIO(client.get(f0[field]).content))
        assert im.format == "WEBP" and im.size == size
    assert client.get("/frames", params={**T, "fov": 6}).json()["fov_arcmin"] == 6.0   # a smaller field still works
    d = client.get("/diff", params={**T, "a": 0, "b": 1})
    assert d.headers["content-type"] == "image/webp" and Image.open(io.BytesIO(d.content)).size == tuple(body["large_shape"][::-1])


def test_large_field_detectors_bands_and_spectrum(client, large_cache):
    det = client.get("/frames_by_detector", params=T).json()
    assert det["image_format"] == "webp" and det["frame_shape"][0] > 250
    assert Image.open(io.BytesIO(client.get(det["png_url_color"]).content)).size == tuple(det["large_shape"][::-1])
    bands = client.get("/frames_by_band", params=T).json()
    assert bands["n_bands_with_data"] == 2 and bands["frame_shape"] == det["frame_shape"]
    assert Image.open(io.BytesIO(client.get(next(b["webp_url"] for b in bands["bands"] if b["webp_url"])).content)).size == tuple(bands["large_shape"][::-1])
    # photometry is unchanged by the bigger field: same known flux recovered
    from api.photometry import AP_RADIUS_PX
    pix_sr = (6.2 / 3600) ** 2 * (np.pi / 180) ** 2
    expected = STAR_SUM * (1 - np.exp(-AP_RADIUS_PX ** 2 / (2 * 1.1 ** 2))) * 1e6 * pix_sr
    pts = client.get("/spectrum", params=T).json()["spectrum"]
    assert len(pts) == 6 and all(abs(p["flux"] - expected) / expected < 0.06 for p in pts)


def test_use_large_switch(large_cache):
    import api.load_cache as lc
    assert lc.target_dir("barnards-star") == large_cache / "barnards-star"
    lc.use_large(False)
    try:
        assert lc.target_dir("barnards-star") != large_cache / "barnards-star"
    finally:
        lc.use_large(True)
