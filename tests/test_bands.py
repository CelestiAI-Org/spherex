"""The 102 spectral bands: channel table, assignment, /frames_by_band."""
import io
import json

import numpy as np
from PIL import Image

from api import bands

T = {"target": "barnards-star"}


def test_channel_table_is_the_official_102():
    ch = bands.CHANNELS
    assert len(ch) == 102 and [c["band_index"] for c in ch] == list(range(102))
    for d in range(1, 7):
        mine = [c for c in ch if c["detector"] == d]
        assert len(mine) == 17 and [c["subchannel"] for c in mine] == list(range(1, 18))
    waves = [c["wavelength_um"] for c in ch]
    assert waves == sorted(waves) and 0.74 < waves[0] < 0.76 and 4.98 < waves[-1] < 5.0


def test_assign_uses_detector_and_edges():
    assert bands.assign(1, 1.001) == 12                       # detector 1, channel 13 (centre 1.0010 um)
    assert bands.assign(2, 1.412) == 17 + 10                   # detector 2, channel 11
    assert bands.assign(1, 4.5) is None                        # not in detector 1's range
    assert bands.assign(2, 1.09) is None                       # LVF extends past detector 2's first channel edge
    assert bands.assign(3, None) is None and bands.assign(9, 1.0) is None


def test_frames_by_band_endpoint(client):
    r = client.get("/frames_by_band", params=T)
    assert r.status_code == 200
    b = r.json()
    assert b["format"] == "webp" and b["n_bands"] == len(b["bands"]) == 102 and b["n_bands_with_data"] == 2
    items = b["bands"]
    assert [i["wavelength_um"] for i in items] == sorted(i["wavelength_um"] for i in items)   # ordered by wavelength
    with_data = [i for i in items if i["webp_url"]]
    assert {i["band_index"] for i in with_data} == {12, 27}
    for i in with_data:
        assert i["n_images"] == 3 and i["wavelength_um_min"] < i["measured_wavelength_um"][0] <= i["measured_wavelength_um"][1] < i["wavelength_um_max"] + 0.01
        resp = client.get(i["webp_url"])
        img = Image.open(io.BytesIO(resp.content))
        assert img.format == "WEBP" and list(img.size[::-1]) == b["large_shape"]
    assert all(i["quality"] in ("ok", "low") and i["noise_mjy_sr"] > 0 and 0 <= i["nodata_fraction"] < 1 for i in with_data)
    assert b["n_bands_low_quality"] == sum(1 for i in items if i["quality"] == "low")
    for i in items:
        if not i["webp_url"]:
            assert i["n_images"] == 0 and "note" in i                  # empty bands are reported, not hidden


def test_bands_share_one_brightness_scale(client):
    items = [i for i in client.get("/frames_by_band", params=T).json()["bands"] if i["webp_url"]]
    imgs = [np.asarray(Image.open(io.BytesIO(client.get(i["webp_url"]).content))) for i in items]
    assert all(im.max() > 0 for im in imgs)                    # not blank
    # same synthetic star (same flux) in both bands: with ONE shared scale its brightness agrees
    c = [im[im.shape[0] // 2 - 30:im.shape[0] // 2 + 30, im.shape[1] // 2 - 30:im.shape[1] // 2 + 30].max() for im in imgs]
    assert abs(int(c[0]) - int(c[1])) < 25


def test_static_bands_and_missing_bands(client, tmp_path, monkeypatch):
    import api.main as m
    (tmp_path / "barnards-star").mkdir()
    (tmp_path / "barnards-star" / "frames.json").write_text(json.dumps({"frames": []}))
    monkeypatch.setattr(m, "STATIC_EXPORT_DIR", tmp_path)
    monkeypatch.setattr(m, "PREFER_STATIC", True)
    r = client.get("/frames_by_band", params=T)                 # static data present but no bands.json
    assert r.status_code == 404 and "error" in r.json() and "targets_with_bands" in r.json()
    (tmp_path / "barnards-star" / "bands.json").write_text(json.dumps({"n_bands": 102, "bands": []}))
    assert client.get("/frames_by_band", params=T).json()["n_bands"] == 102
    assert {x["key"]: x for x in client.get("/targets").json()}["barnards-star"]["has_bands"] is True


def test_local_noise_ignores_gradients_and_flags_noisy_band():
    import numpy as np
    from api import display
    rng = np.random.default_rng(3)
    y, x = np.mgrid[:80, :80]
    flat = rng.normal(0, 1.0, (80, 80))
    tilted = flat + 0.5 * x                                   # strong sky gradient, same random noise
    assert abs(display.local_noise(tilted) - display.local_noise(flat)) < 0.15
    assert 0.9 < display.local_noise(flat) < 1.1
    assert display.local_noise(np.full((80, 80), np.nan)) is None
