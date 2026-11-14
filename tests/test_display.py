"""Stretch / upscale / colour rendering (no invented detail, shared scales)."""
import io

import numpy as np
from PIL import Image

from api import display


def test_asinh_stretch_shared_scale_and_compression():
    rng = np.random.default_rng(0)
    a = rng.normal(0, 1, (200, 200))
    a[100:102, 100:150] = 3000                                      # 100 very bright pixels set the white point
    b = a.copy()
    a[20, 20], b[20, 20] = 50, 20                                   # same star, brighter in a than in b
    sc = display.stretch_scale([a, b])
    sa, sb = display.asinh_stretch(a, sc), display.asinh_stretch(b, sc)
    assert sa.min() >= 0 and sa.max() <= 1
    assert sa[20, 20] > sb[20, 20]                                  # one shared scale: brighter stays brighter
    assert 0.05 < sb[20, 20] < sa[20, 20] < 1.0                     # neither is clipped to white
    lin = np.clip((a - sc[0]) / (sc[1] - sc[0]), 0, 1)
    assert sa[20, 20] > lin[20, 20] * 5                             # asinh lifts a 50-sigma source far above linear
    assert display.asinh_stretch(np.full((3, 3), np.nan), sc).max() == 0   # no data -> black


def test_lanczos_upscale_preserves_content():
    rng = np.random.default_rng(1)
    img = np.clip(rng.normal(0.3, 0.1, (20, 20)), 0, 1)
    big = display.upscale(img, 6)
    assert big.shape == (120, 120) and big.dtype == np.uint8
    assert abs(big.mean() / 255 - img.mean()) < 0.01               # interpolation does not change the brightness
    # sampling the upscaled image back at the original pixel centres recovers the data (no invented values)
    back = big[3::6, 3::6] / 255
    assert np.abs(back - img).mean() < 0.03
    rgb = display.upscale(np.stack([img, img * 0.5, img * 0.2], axis=-1), 6)
    assert rgb.shape == (120, 120, 3)


def test_signed_asinh_diff_is_centred():
    d = np.zeros((30, 30)); d[10, 10] = 40; d[20, 20] = -40
    d += np.random.default_rng(2).normal(0, 0.5, d.shape)
    s = display.signed_asinh(d)
    assert s[10, 10] > 0.9 and s[20, 20] < 0.1 and abs(np.median(s) - 0.5) < 0.05


def test_diff_endpoint_is_large_png(client):
    r = client.get("/diff", params={"target": "barnards-star", "a": 0, "b": 2})
    assert r.status_code == 200
    img = Image.open(io.BytesIO(r.content))
    h, w = client.get("/frames", params={"target": "barnards-star"}).json()["frame_shape"]
    assert img.size == (w * 6, h * 6)


def test_channel_legend_uses_measured_wavelengths():
    meta = [{"detector": 1, "wavelength_um": 0.9}, {"detector": 2, "wavelength_um": 1.5}, {"detector": 5, "wavelength_um": 4.0}]
    legend = display.channel_legend(meta)
    assert legend["blue"]["wavelength_um"] == [0.9, 1.5] and legend["red"]["wavelength_um"] == [4.0, 4.0]
    assert legend["green"]["wavelength_um"] is None


def test_fill_small_holes_only_fills_enclosed_holes():
    img = np.ones((30, 30)) * 5.0
    img[10:13, 10:13] = np.nan          # enclosed hole -> filled
    img[0:6, 0:6] = np.nan              # touches the border (empty corner) -> left alone
    img[20:28, 20:28] = np.nan          # 64 px enclosed hole -> filled (<= 80)
    out = display.fill_small_holes(img)
    assert np.isfinite(out[10:13, 10:13]).all() and np.allclose(out[10:13, 10:13], 5.0)
    assert np.isfinite(out[20:28, 20:28]).all()
    assert np.isnan(out[0:6, 0:6]).all()
    big = np.ones((60, 60)); big[20:40, 20:40] = np.nan   # 400 px hole -> too big to be a dead-pixel hole
    assert np.isnan(display.fill_small_holes(big)[25:35, 25:35]).all()
