"""Export every cached target to static_export/ (JSON + PNGs) as an offline backup.

    python scripts/export_static.py

Writes static_export/<key>/frames.json (same shape as the /frames response, with
urls like /static/<key>/0.png) and the PNGs. The API serves these if the cache is missing.
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
        (d / "frames.json").write_text(json.dumps(body, indent=1))
        exported[key] = {**t, "frames": len(body["frames"])}
        print(f"[{key}] exported {len(body['frames'])} frames")
    (OUT / "targets.json").write_text(json.dumps(exported, indent=1))
    print(f"Done: {len(exported)} targets -> {OUT}")


if __name__ == "__main__":
    main()
