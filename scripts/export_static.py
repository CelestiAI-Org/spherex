"""Export every cached target to static_export/ (JSON + PNGs) as an offline backup / the deployed data.

    python scripts/export_static.py

Per target, static_export/<key>/ gets: frames.json (same shape as the /frames response, urls rewritten to
/static/<key>/...), spectrum.json, detectors.json, and the PNGs:
    <i>.png (large) <i>_native.png <i>_color.png      one set per visit
    diff_<a>_<b>.png                                  differences of consecutive visits
    det<d>.png det<d>_native.png detectors_color.png  one frame per detector + false-colour composite
    before/<i>.png                                    the OLD rendering (linear stretch, nearest-neighbour), for comparison
and static_export/compare.html shows before/after for every target.
"""
import html
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from api import display  # noqa: E402
from api.load_cache import load_index  # noqa: E402
from api.main import app, cached_fov, compute_frames  # noqa: E402
from api.targets import REAL_TARGETS, TARGETS  # noqa: E402

OUT = ROOT / "static_export"


def save_png(client, url, dest):
    dest.write_bytes(client.get(url).content)


def export_target(client, key):
    t = TARGETS[key]
    r = client.get("/frames", params={"ra": t["ra"], "dec": t["dec"]})
    if r.status_code != 200:
        print(f"[{key}] /frames failed: {r.status_code} {r.text[:100]}")
        return None
    body = r.json()
    d = OUT / key
    (d / "before").mkdir(parents=True)
    for f in body["frames"]:
        i = f["index"]
        for field, name in (("png_url_large", f"{i}.png"), ("png_url_native", f"{i}_native.png"), ("png_url_color", f"{i}_color.png")):
            if f[field]:
                save_png(client, f[field], d / name)
                f[field] = f"/static/{key}/{name}"
        f["url"] = f["png_url_large"]
    # the old look: the pipeline's linear 0-1 frame, shown with nearest-neighbour blocks at the same size
    frames, _, _ = compute_frames(key, round(t["ra"], 5), round(t["dec"], 5), round(min(6.0, cached_fov(key)), 3))
    for i, fr in enumerate(frames):
        Image.fromarray(display.to_uint8(fr.image)).resize((fr.image.shape[1] * display.UPSCALE, fr.image.shape[0] * display.UPSCALE),
                                                           Image.NEAREST).save(d / "before" / f"{i}.png")
    # differences between consecutive visits
    body["diffs"] = []
    for i in range(len(body["frames"]) - 1):
        r = client.get("/diff", params={"ra": t["ra"], "dec": t["dec"], "a": i, "b": i + 1})
        if r.status_code == 200:
            (d / f"diff_{i}_{i + 1}.png").write_bytes(r.content)
            body["diffs"].append({"a": i, "b": i + 1, "url": f"/static/{key}/diff_{i}_{i + 1}.png"})
    (d / "frames.json").write_text(json.dumps(body, indent=1))
    # spectrum + detectors
    spec = client.get("/spectrum", params={"target": key}).json()
    (d / "spectrum.json").write_text(json.dumps(spec, separators=(",", ":")))
    det = client.get("/frames_by_detector", params={"target": key}).json()
    for e in det["detectors"]:
        if e["png_url"]:
            n = e["detector"]
            save_png(client, e["png_url"], d / f"det{n}.png")
            save_png(client, e["png_url_native"], d / f"det{n}_native.png")
            e["png_url"], e["png_url_native"] = f"/static/{key}/det{n}.png", f"/static/{key}/det{n}_native.png"
    if det["png_url_color"]:
        save_png(client, det["png_url_color"], d / "detectors_color.png")
        det["png_url_color"] = f"/static/{key}/detectors_color.png"
    (d / "detectors.json").write_text(json.dumps(det, indent=1))
    print(f"[{key}] exported {len(body['frames'])} frames, {len(body['diffs'])} diffs, spectrum {spec['n_points']} pts")
    return {**t, "frames": len(body["frames"]), "spectrum_points": spec["n_points"], "channels": body["color_channels"]}


def write_compare_page(exported):
    rows = []
    for key, info in exported.items():
        body = json.loads((OUT / key / "frames.json").read_text())
        det = json.loads((OUT / key / "detectors.json").read_text())
        cells = []
        for f in body["frames"]:
            i = f["index"]
            cells.append(f'<figure><figcaption>visit {i + 1} BEFORE (linear, nearest)</figcaption><img src="/static/{key}/before/{i}.png"></figure>'
                         f'<figure><figcaption>visit {i + 1} AFTER (asinh, Lanczos)</figcaption><img src="{f["png_url_large"]}"></figure>'
                         + (f'<figure><figcaption>visit {i + 1} colour</figcaption><img src="{f["png_url_color"]}"></figure>' if f["png_url_color"] else ""))
        dets = "".join(f'<figure><figcaption>D{e["detector"]} {e["wavelength_range_um"]} um</figcaption><img src="{e["png_url"]}"></figure>' for e in det["detectors"] if e["png_url"])
        legend = "; ".join(f'{c}: D{"+".join(map(str, v["detectors"]))} {v["wavelength_um"][0]}-{v["wavelength_um"][1]} um' for c, v in (body["color_channels"] or {}).items() if v["wavelength_um"])
        rows.append(f'<h2>{html.escape(info["name"])}</h2><p>{html.escape(legend)}</p><div class="row">{"".join(cells)}</div>'
                    f'<h3>By detector (all visits) and colour composite</h3><div class="row">{dets}'
                    + (f'<figure><figcaption>false colour</figcaption><img src="{det["png_url_color"]}"></figure>' if det["png_url_color"] else "") + "</div>")
    page = ('<!doctype html><meta charset="utf-8"><title>SPHEREx image comparison</title><style>'
            'body{background:#111;color:#ddd;font:14px sans-serif;margin:16px}.row{display:flex;flex-wrap:wrap;gap:8px}'
            'figure{margin:0}img{width:340px;height:340px;image-rendering:auto}figcaption{font-size:12px;color:#999}</style>'
            '<h1>Before / after: real SPHEREx data, no invented detail</h1>' + "".join(rows))
    (OUT / "compare.html").write_text(page)


def main():
    client = TestClient(app)
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    exported = {}
    for key in REAL_TARGETS:
        if not load_index(key):
            print(f"[{key}] no cache - skipped")
            continue
        info = export_target(client, key)
        if info:
            exported[key] = info
    (OUT / "targets.json").write_text(json.dumps(exported, indent=1))
    write_compare_page(exported)
    print(f"Done: {len(exported)} targets -> {OUT}")


if __name__ == "__main__":
    main()
