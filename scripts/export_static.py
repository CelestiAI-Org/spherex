"""Export every cached target to static_export/ (JSON + PNGs) as an offline backup.

    python scripts/export_static.py

Writes static_export/<key>/frames.json (same shape as the /frames response, with
urls like /static/<key>/0.png, plus a "diffs" list), the frame PNGs and diff_<a>_<b>.png for consecutive visits. The API serves these if the cache is missing.
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from api.load_cache import load_index  # noqa: E402
from api.main import app  # noqa: E402
from api.targets import REAL_TARGETS, TARGETS  # noqa: E402

OUT = ROOT / "static_export"


def main():
    client = TestClient(app)
    if OUT.exists():
        shutil.rmtree(OUT)
    exported = {}
    for key in REAL_TARGETS:
        t = TARGETS[key]
        if not load_index(key):
            print(f"[{key}] no cache - skipped")
            continue
        r = client.get("/frames", params={"ra": t["ra"], "dec": t["dec"]})
        if r.status_code != 200:
            print(f"[{key}] /frames failed: {r.status_code} {r.text[:100]}")
            continue
        body = r.json()
        d = OUT / key
        d.mkdir(parents=True)
        for f in body["frames"]:
            (d / f"{f['index']}.png").write_bytes(client.get(f["url"]).content)
            f["url"] = f"/static/{key}/{f['index']}.png"
        # difference PNGs between consecutive visits, so /diff works from static files alone
        body["diffs"] = []
        for i in range(len(body["frames"]) - 1):
            r = client.get("/diff", params={"ra": t["ra"], "dec": t["dec"], "a": i, "b": i + 1})
            if r.status_code == 200:
                (d / f"diff_{i}_{i + 1}.png").write_bytes(r.content)
                body["diffs"].append({"a": i, "b": i + 1, "url": f"/static/{key}/diff_{i}_{i + 1}.png"})
        (d / "frames.json").write_text(json.dumps(body, indent=1))
        # multi-band: spectrum + one frame per detector (served by /spectrum and /frames_by_detector on the server)
        spec = client.get("/spectrum", params={"target": key}).json()
        (d / "spectrum.json").write_text(json.dumps(spec, separators=(",", ":")))
        det = client.get("/frames_by_detector", params={"target": key}).json()
        for e in det["detectors"]:
            if e["png_url"]:
                (d / f"det{e['detector']}.png").write_bytes(client.get(e["png_url"]).content)
                e["png_url"] = f"/static/{key}/det{e['detector']}.png"
        (d / "detectors.json").write_text(json.dumps(det, indent=1))
        exported[key] = {**t, "frames": len(body["frames"]), "spectrum_points": spec["n_points"]}
        print(f"[{key}] exported {len(body['frames'])} frames")
    (OUT / "targets.json").write_text(json.dumps(exported, indent=1))
    print(f"Done: {len(exported)} targets -> {OUT}")


if __name__ == "__main__":
    main()
