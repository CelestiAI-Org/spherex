"""Search IRSA and cache cutouts for targets.

    python scripts/precache.py barnards-star          # one target
    python scripts/precache.py --all                  # all targets in api/targets.py

Layout written (see CACHE.md):
    cache/<key>/search.json      SIA search summary (counts, time range, columns)
    cache/<key>/cutouts/*.fits   one FITS cutout per SPHEREx image
    cache/<key>/index.json       list of cutouts (file, mjd, detector) + fov_arcmin
Re-running skips files that are already cached.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import irsa  # noqa: E402
from api.load_cache import CACHE_DIR, load_cutout  # noqa: E402
from api.targets import DEFAULT_FOV_ARCMIN, TARGETS  # noqa: E402

VISIT_GAP_DAYS = 3.0


def count_visits(mjds):
    mjds = sorted(mjds)
    return sum(1 for i, m in enumerate(mjds) if i == 0 or m - mjds[i - 1] > VISIT_GAP_DAYS)


def precache(key: str, fov: float = DEFAULT_FOV_ARCMIN, max_images: int | None = None) -> dict:
    t = TARGETS[key]
    out = CACHE_DIR / key
    (out / "cutouts").mkdir(parents=True, exist_ok=True)

    table = irsa.sia_search(t["ra"], t["dec"], radius_deg=fov / 60 / 2)
    info = irsa.summarise(table)
    print(f"[{key}] SIA: {info['n_images']} images, MJD range {info.get('mjd_range')}")
    print(f"[{key}] columns used: {info['columns_used']}")
    (out / "search.json").write_text(json.dumps(info, indent=2))
    cols = info["columns_used"]
    if not cols["url"]:
        raise SystemExit(f"No access URL column in {info['all_columns']}")

    rows = []
    for i, row in enumerate(table):
        if max_images and i >= max_images:
            break
        ident = str(row[cols["id"]]) if cols["id"] else f"img{i}"
        name = "".join(c if c.isalnum() or c in "-_" else "_" for c in ident) + ".fits"
        dest = out / "cutouts" / name
        if not dest.exists():
            url = irsa.cutout_url(str(row[cols["url"]]), t["ra"], t["dec"], fov)
            if not irsa.download_cutout(url, dest):
                print(f"[{key}] FAILED {ident}")
                continue
        c = load_cutout(dest)
        rows.append({"file": name, "mjd": c.mjd, "detector": c.detector})
        print(f"[{key}] {i + 1}/{len(table)} {name} mjd={c.mjd:.3f} det={c.detector}")

    (out / "index.json").write_text(json.dumps({"fov_arcmin": fov, "cutouts": rows}, indent=1))
    visits = count_visits([r["mjd"] for r in rows])
    summary = {"target": key, "images": len(rows), "visits": visits}
    print(f"[{key}] DONE: {summary}" + ("  ** WARNING: fewer than 2 visits - no time-lapse possible **" if visits < 2 else ""))
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--fov", type=float, default=DEFAULT_FOV_ARCMIN)
    ap.add_argument("--max-images", type=int)
    a = ap.parse_args()
    keys = list(TARGETS) if a.all else a.targets
    results = []
    for k in keys:
        try:
            results.append(precache(k, a.fov, a.max_images))
        except Exception as e:  # keep going so one bad target doesn't block the others
            print(f"[{k}] ERROR: {e}")
            results.append({"target": k, "images": 0, "visits": 0, "error": str(e)})
    print("\n=== SUMMARY ===")
    for r in results:
        flag = "  <-- FEWER THAN 2 VISITS" if r["visits"] < 2 else ""
        print(f"{r['target']:20s} visits={r['visits']:3d} images={r['images']:4d}{flag}")
