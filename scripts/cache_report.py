"""Print (and write to DATA_REPORT.md) visits and images per cached target; flag targets with < 2 visits."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from api.load_cache import load_index  # noqa: E402
from api.targets import REAL_TARGETS  # noqa: E402

GAP = 60.0  # days, same as api/fallback.py


def main():
    lines = ["| target | SIA images | cached cutouts | visits | MJD ranges of visits | flag |", "|---|---|---|---|---|---|"]
    for key in REAL_TARGETS:
        rows = load_index(key)
        if not rows:
            lines.append(f"| {key} | - | 0 | - | not cached yet | NOT CACHED |")
            continue
        sia = json.loads((ROOT / "cache" / key / "search.json").read_text())["n_images"] if (ROOT / "cache" / key / "search.json").exists() else "?"
        m = sorted(r["mjd"] for r in rows)
        visits = [[m[0], m[0]]]
        for t in m[1:]:
            if t - visits[-1][1] > GAP:
                visits.append([t, t])
            else:
                visits[-1][1] = t
        rng = "; ".join(f"{a:.0f}-{b:.0f}" for a, b in visits)
        flag = "**FEWER THAN 2 VISITS**" if len(visits) < 2 else ""
        lines.append(f"| {key} | {sia} | {len(rows)} | {len(visits)} | {rng} | {flag} |")
    text = "\n".join(lines)
    print(text)
    (ROOT / "DATA_REPORT.md").write_text("# Data per target\n\nVisits = groups of images separated by > 60 days.\n\n" + text + "\n")


if __name__ == "__main__":
    main()
