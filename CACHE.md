# Cutout cache

Everything the API serves comes from `cache/` (gitignored - rebuild it with
`python scripts/precache.py --all`). The API never downloads anything while serving a request.

```
cache/
  <target_key>/            e.g. barnards-star  (keys are listed in api/targets.py)
    search.json            SIA search summary: number of images, MJD range, columns used
    index.json             {"fov_arcmin": 6.0, "cutouts": [{"file", "mjd", "detector"}, ...]}
    cutouts/*.fits         one IRSA cutout per SPHEREx image (IMAGE, FLAGS, VARIANCE, ZODI, WCS-WAVE; the 4 MB EPSF table is dropped)
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
c.flags      # raw FLAGS bit field - NOT 0 = good, see below
c.wcs        # astropy WCS of the cutout
c.mjd        # observation time (MJD)
c.detector   # 1-6
```

Set `SPHEREX_CACHE_DIR=/some/path` to point at a different cache folder.

## Things to know about the real data

* **FLAGS is a bit field**, and ~98% of pixels have bit 21 (SOURCE, "mapped to a known source") set, so
  `flags == 0` is almost never true. Use `from api.load_cache import BAD_PIXEL_MASK` and
  `good = (c.flags & BAD_PIXEL_MASK) == 0`. The mask contains every documented bit except 12 (FULLSAMPLE) and
  21 (SOURCE). Bit names/meanings are in the FLAGS extension header (`MSKNnnnn`, `MSKDnnnn`).
  The cores of bright stars (Barnard's Star) are flagged 0/1/2/26 (TRANSIENT/OVERFLOW/SUR_ERROR/BLOOM) - the
  fallback stacker keeps those pixels so the star is not a black hole; your pipeline can decide differently.
* **Visits:** ~100-190 images (6 detectors x many wavelengths) are taken per pass over a position, spread over
  20-50 days, with 100+ days between passes. Barnard's Star has 3 passes (MJD ~60902-60949, 61110-61165,
  61268-61306). Group with a gap threshold of ~60 days, not a few days.
* Images in one visit are at **different wavelengths** (each detector is a linear variable filter), so stars
  change brightness between images; the median stack is only a rough combination.
* `IMAGE - ZODI` is used for `Cutout.image` (the ZODI median is similar to the IMAGE median, so the zodiacal
  light has not been removed from IMAGE). `Cutout.mjd` is `MJD-AVG`; `Cutout.detector` is `DETECTOR`.
* The cache is centred on the **epoch-2026 position** of each target (proper motion applied, see
  `api/targets.py`) - Barnard's Star has moved ~4.5' since J2000.
* The fake target `fake_mover` (see `scripts/make_fake_cutouts.py`) uses the same layout.
* `Cutout.wavelength_um` (optional, default None) is filled by `load_cutouts` from `WCS-WAVE` at the target's
  proper-motion-propagated position (the nearest edge pixel if the target is off-image). See DATA_REPORT.md for
  how many cutouts per target have one (all but 2-3 edge slivers).
