"""Wavelength, /spectrum and /frames_by_detector (synthetic cutouts: detector 1 ~1 um, detector 2 ~3 um)."""
import io
import json
import shutil

import numpy as np
from astropy.io import fits
from astropy.wcs.utils import proj_plane_pixel_area
from PIL import Image

from api.load_cache import CACHE_DIR, load_cutout, load_cutouts, target_dir
from tests.conftest import STAR_SUM

T = {"target": "barnards-star"}


def test_wavelength_loaded_from_wcs_wave():
    cutouts = load_cutouts("barnards-star")
    assert len(cutouts) == 6 and all(c.wavelength_um is not None for c in cutouts)
    for c in cutouts:
        expected = 1.0 if c.detector == 1 else 3.0
        assert abs(c.wavelength_um - expected) < 0.05


def test_cutout_without_wcs_wave_has_no_wavelength(tmp_path):
    src = next((target_dir("barnards-star") / "cutouts").glob("*.fits"))
    with fits.open(src) as h:
        fits.HDUList([e for e in h if e.name != "WCS-WAVE"]).writeto(tmp_path / "x.fits")
    assert load_cutout(tmp_path / "x.fits").wavelength_um is None


def test_spectrum_recovers_known_flux(client):
    r = client.get("/spectrum", params=T)
    assert r.status_code == 200
    body = r.json()
    pts = body["spectrum"]
    assert body["flux_unit"] == "Jy" and body["n_points"] == len(pts) == 6
    waves = [p["wavelength_um"] for p in pts]
    assert waves == sorted(waves)                                  # sorted by wavelength
    assert {p["detector"] for p in pts} == {1, 2}
    # expected: STAR_SUM counts (MJy/sr summed over pixels) x fraction inside r=3 px x pixel solid angle -> Jy
    from api.photometry import AP_RADIUS_PX
    pix_sr = (6.2 / 3600) ** 2 * (np.pi / 180) ** 2
    enclosed = 1 - np.exp(-AP_RADIUS_PX ** 2 / (2 * 1.1 ** 2))
    expected = STAR_SUM * enclosed * 1e6 * pix_sr
    for p in pts:
        assert abs(p["flux"] - expected) / expected < 0.06, (p, expected)
        assert p["flux_err"] is not None and p["flux_err"] > 0
        assert p["saturated"] is False


def test_spectrum_flags_saturated_core(tmp_path):
    from api.photometry import measure
    from api.targets import TARGETS
    src = next((target_dir("barnards-star") / "cutouts").glob("*.fits"))
    shutil.copy(src, tmp_path / "s.fits")
    with fits.open(tmp_path / "s.fits", mode="update") as h:
        n = h["FLAGS"].data.shape[0] // 2
        h["FLAGS"].data[n - 12:n + 12, n - 12:n + 12] = 1 << 1    # OVERFLOW pixels around the target
    pt = measure(tmp_path / "s.fits", TARGETS["barnards-star"])
    assert pt is not None and pt["saturated"] is True and np.isfinite(pt["flux"])


def test_spectrum_exclude_saturated_and_errors(client):
    assert client.get("/spectrum", params={**T, "exclude_saturated": True}).json()["n_points"] == 6
    assert client.get("/spectrum", params={"ra": 10, "dec": 10}).status_code == 404


def test_frames_by_detector(client):
    r = client.get("/frames_by_detector", params=T)
    assert r.status_code == 200
    body = r.json()
    dets = {d["detector"]: d for d in body["detectors"]}
    assert sorted(dets) == [1, 2, 3, 4, 5, 6] and body["shared_scale"] is True
    frames_shape = client.get("/frames", params=T).json()["frame_shape"]
    assert body["frame_shape"] == frames_shape                      # same grid as build_frames
    for d in (1, 2):
        assert dets[d]["n_images"] == 3
        lo, hi = dets[d]["wavelength_range_um"]
        assert lo <= hi and abs((lo + hi) / 2 - (1.0 if d == 1 else 3.0)) < 0.05
        img = Image.open(io.BytesIO(client.get(dets[d]["png_url"]).content))
        assert list(img.size[::-1]) == body["large_shape"] == [x * 6 for x in frames_shape]
        assert Image.open(io.BytesIO(client.get(dets[d]["png_url_native"]).content)).size == tuple(frames_shape[::-1])
        assert dets[d]["channel"] == "blue"                         # detectors 1+2 -> blue
    color = Image.open(io.BytesIO(client.get(body["png_url_color"]).content))
    assert color.mode == "RGB" and list(color.size[::-1]) == body["large_shape"]
    assert body["color_channels"]["blue"]["wavelength_um"] is not None and body["color_channels"]["red"]["wavelength_um"] is None
    for d in (3, 4, 5, 6):                                          # no data: reported, not hidden
        assert dets[d]["png_url"] is None and dets[d]["n_images"] == 0 and "note" in dets[d]


def test_static_export_serves_spectrum_and_detectors(client, tmp_path, monkeypatch):
    import api.main as m
    (tmp_path / "barnards-star").mkdir()
    for name, body in (("frames.json", {"frames": []}), ("spectrum.json", {"spectrum": [{"saturated": True}], "n_points": 1}),
                       ("detectors.json", {"detectors": [], "shared_scale": True})):
        (tmp_path / "barnards-star" / name).write_text(json.dumps(body))
    monkeypatch.setattr(m, "STATIC_EXPORT_DIR", tmp_path)
    monkeypatch.setattr(m, "PREFER_STATIC", True)
    assert client.get("/spectrum", params=T).json()["n_points"] == 1
    assert client.get("/spectrum", params={**T, "exclude_saturated": True}).json()["n_points"] == 0
    assert client.get("/frames_by_detector", params=T).json()["shared_scale"] is True
