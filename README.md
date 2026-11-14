# SPHEREx time-lapse

Pick a star, get a time-lapse of how that patch of sky looked each time NASA's SPHEREx
telescope observed it - plus a difference image between any two visits.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the pipeline in five lines and [CACHE.md](CACHE.md) for the data cache.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python scripts/precache.py --all          # one-off: search IRSA + download cutouts into cache/
uvicorn api.main:app --port 8000          # serve  (docs at http://localhost:8000/docs)
pytest                                    # tests use synthetic cutouts, no network needed
```

Offline backup: `python scripts/export_static.py` writes `static_export/` (JSON + PNGs for every
cached target, plus difference PNGs between consecutive visits). It is committed to git and is what the
deployed server serves (`SPHEREX_PREFER_STATIC=1` in the Dockerfile, and `cache/` is excluded from the image by `.dockerignore`): `/frames` ignores `fov` there, and `/diff` only works for `b = a + 1`.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /health` | `{status, pipeline, cached_targets, static_targets}`; `pipeline` is `science.pipeline` or `fallback` |
| `GET /targets` | every cached target: `[{key, name, ra, dec, visits, source, frames_url}]` - lets the frontend use names, not coordinates |
| `GET /resolve?name=Barnard's Star` | `{name, key, ra, dec, source, cached}` - known targets from our table, others via CDS Sesame |
| `GET /frames?target=barnards-star` or `?ra=&dec=&fov=` | `{target, ra, dec, fov_arcmin, pipeline, frame_shape, matched_distance_arcmin, frames:[{index, url, mjd_start, mjd_end, n_images}]}`; each `url` is a PNG (north up, east left). With `ra`/`dec` it matches the nearest cached target within 10 arcmin (catalogue or 2026 position); otherwise a JSON error `{"error", "nearest", "available_targets"}` (404) |
| `GET /diff?target=&a=&b=` (or `ra=&dec=`) | PNG difference of frames `a` and `b` (mid-grey = no change) |
| `GET /spectrum?target=barnards-star` (or `ra=&dec=`; optional `exclude_saturated=true`) | `{target, flux_unit:"Jy", aperture_radius_px, n_points, n_saturated, spectrum:[{wavelength_um, flux, flux_err, detector, mjd, saturated, n_masked}]}` sorted by wavelength: aperture photometry (r = 3 px, median sky annulus 8-14 px, bad pixels masked) of the epoch-propagated target position in every cutout that contains it. `flux_err` is statistical only (from VARIANCE). **`saturated: true` means core pixels are flagged OVERFLOW, so the flux is a biased-low lower limit** (see below) |
| `GET /frames_by_detector?target=barnards-star` | `{frame_shape, shared_scale, detectors:[{detector 1-6, n_images, wavelength_range_um, png_url}]}`: one stacked frame per detector (all epochs), same grid as `/frames`, one shared brightness scale. A detector without usable data has `png_url: null` and a `note` |

`fov` is in arcmin. Responses only use data already in the cache - a request never triggers a download.
`/frames` uses `science.pipeline.build_frames` (falling back to `api/fallback.py` if it raises any exception or returns no frames; `pipeline` says which one made the result and `pipeline_error` says why the fallback was used); `/diff` likewise uses `science.pipeline.difference`.
Sample responses for frontend work: `api/sample_frames.json` and `api/sample_frames/`.

## Data credits

Images are from the **SPHEREx** mission (NASA), obtained from the **NASA/IPAC Infrared Science Archive
(IRSA)**, which is operated by the California Institute of Technology under contract with NASA.

## Multi-band notes

* `Cutout.wavelength_um` is the central wavelength at the target position, read from the `WCS-WAVE` extension
  (alternate WCS `W`: wavelength and bandwidth lookup table). All 6 detectors cover ~0.74-5.0 um together;
  each detector is a linear variable filter, so every exposure sees the target at one wavelength.
* **Saturation:** bright stars (Barnard's Star: 348 of 349 points; R Draconis, RW Aurigae) have OVERFLOW/TRANSIENT-flagged
  core pixels. The core holds ~88% of the flux, so those fluxes are lower limits and scatter by up to 3x between
  neighbouring wavelengths, mostly in detectors 1-3. They are kept and flagged, not hidden. Unsaturated targets
  (eps Ind B) give clean spectra.
* No aperture correction is applied (r = 3 px encloses ~94% of the flux); the pixel solid angle comes from the WCS.
