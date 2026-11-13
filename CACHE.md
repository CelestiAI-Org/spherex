# Cutout cache

Everything the API serves comes from `cache/` (gitignored - rebuild it with
`python scripts/precache.py --all`). The API never downloads anything while serving a request.

```
cache/
  <target_key>/            e.g. barnards-star  (keys are listed in api/targets.py)
    search.json            SIA search summary: number of images, MJD range, columns used
    index.json             {"fov_arcmin": 6.0, "cutouts": [{"file", "mjd", "detector"}, ...]}
    cutouts/*.fits         one IRSA cutout per SPHEREx image (extensions IMAGE, FLAGS, ZODI, ...)
  rendered/                PNGs written by /frames (safe to delete)
```

## Loading cutouts (for Futa)

From the repo root (or any notebook - the helper fixes up `sys.path` itself):

```python
from api.load_cache import load_cutouts
from science.types import Cutout

cutouts = load_cutouts("barnards-star")      # list[Cutout], sorted by time
c = cutouts[0]
c.image      # IMAGE minus ZODI (background-subtracted), 2D float array
c.flags      # FLAGS extension (0 = good pixel)
c.wcs        # astropy WCS of the cutout
c.mjd        # observation time (MJD)
c.detector   # 1-6
```

Set `SPHEREX_CACHE_DIR=/some/path` to point at a different cache folder.
