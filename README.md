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
| `GET /frames?target=barnards-star` or `?ra=&dec=&fov=` | `{target, ra, dec, fov_arcmin, pipeline, frame_shape, large_shape, upscale, stretch, color_channels, matched_distance_arcmin, frames:[{index, url, png_url_large, png_url_native, png_url_color, mjd_start, mjd_end, n_images}]}`. `url`/`png_url_large` is a 6x Lanczos PNG, `png_url_native` the native pixels, `png_url_color` a false-colour composite of that visit (north up, east left). With `ra`/`dec` it matches the nearest cached target within 10 arcmin (catalogue or 2026 position); otherwise a JSON error `{"error", "nearest", "available_targets"}` (404) |
| `GET /diff?target=&a=&b=` (or `ra=&dec=`) | 6x Lanczos PNG difference of visits `a` and `b` (mid-grey = no change, bright = brighter in `b`) |
| `GET /frames_by_band?target=barnards-star` | `{format:"webp", n_bands:102, n_bands_with_data, n_bands_low_quality, frame_shape, large_shape, bands:[{band_index 0-101, detector, subchannel, wavelength_um, wavelength_um_min, wavelength_um_max, measured_wavelength_um, n_images, webp_url, noise_mjy_sr, nodata_fraction, quality ("ok"/"low"), quality_notes}]}` ordered by wavelength: one image per official SPHEREx spectral channel (6 detectors x 17), the band's cutouts stacked across all visits, same grid / asinh stretch (ONE scale shared by every band) / 6x Lanczos as `/frames`, saved as lossy WebP. `webp_url: null` = no data. On the deployed server only barnards-star, eps-ind-b and rw-aurigae have band images (others: 404 with `targets_with_bands`) |
| `GET /spectrum?target=barnards-star` (or `ra=&dec=`; optional `exclude_saturated=true`) | `{target, flux_unit:"Jy", aperture_radius_px, n_points, n_saturated, spectrum:[{wavelength_um, flux, flux_err, detector, mjd, saturated, n_masked}]}` sorted by wavelength: aperture photometry (r = 3 px, median sky annulus 8-14 px, bad pixels masked) of the epoch-propagated target position in every cutout that contains it. `flux_err` is statistical only (from VARIANCE). **`saturated: true` means core pixels are flagged OVERFLOW, so the flux is a biased-low lower limit** (see below) |
| `GET /frames_by_detector?target=barnards-star` | `{frame_shape, large_shape, shared_scale, png_url_color, color_channels, detectors:[{detector 1-6, channel, n_images, wavelength_range_um, png_url, png_url_native}]}`: one stacked frame per detector (all epochs), same grid as `/frames`, one shared asinh scale, plus a false-colour composite. A detector without usable data has `png_url: null` and a `note` |

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

## Image rendering (real data only: no AI, nothing invented)

* **Stretch:** asinh between the 1st and 99.95th percentile of all the frames of a target pooled, so every visit of a
  target (and every detector, or every colour channel) shares ONE scale and stays comparable. Faint stars and
  the extended halo of bright stars show up and the stars are not flat white blobs.
* **Upscale:** Lanczos, 6x, done on float data (interpolation only). `png_url_native` is the native 117x117 grid.
* **Colour (false colour, per-channel stretch):** blue = detectors 1+2 (~0.75-1.65 um), green = 3+4 (~1.6-3.8 um),
  red = 5+6 (~3.8-5.0 um). The exact ranges are in `color_channels` of the response.
* Masked pixels fully enclosed by good data (cores of bright stars, dead pixels) are filled with the mean of their
  neighbours; empty edges of rotated cutouts stay black.
* Tried and NOT kept: drizzle on a finer grid (inconsistent sharpness, adds a lattice pattern) and unsharp-mask
  sharpening (no clear gain, lumpy saturated cores).
* `static_export/compare.html` (served at `/static/compare.html`) shows before/after for every target.

## Spectral bands

* The 102 bands come from the official SPECTRAL_CHANNELS table (`api/spectral_channels.json`, 6 detectors x 17 channels,
  edges in um). An exposure's band = the channel of ITS detector whose centre is nearest to the wavelength at the target.
  Exposures beyond their detector's outermost channel edge (about 3%) are left out (`n_cutouts_outside_all_channels`).
* Typical band = 3 images (one per visit); eps Ind B 2-9. Band images are single-exposure-like: expect grain, especially in
  detectors 5-6, sky gradients in detectors 1-2, and dark pits in the saturated cores of bright stars.
* `quality: "low"` marks bands that are a single image, much noisier than the target's typical band, or with a large
  missing-data area. `noise_mjy_sr` is a pixel-to-pixel noise (2x-oversampled grid, so slightly underestimated).
* `static_export/bands.html` (served at `/static/bands.html`) is a slider demo.

## Large field (15 arcmin) for the hero targets

* `cache_large/<key>/` (same layout as `cache/`, cutouts of 0.25 deg = 15') exists for barnards-star, eps-ind-b and
  rw-aurigae, made with `SPHEREX_CACHE_DIR=cache_large python scripts/precache.py <targets> --fov 15`. A target found
  there is used instead of the 6' one (`SPHEREX_USE_LARGE=0` forces the 6' cache; `cache/` is kept as the fallback).
  `cache_large/` is excluded from the Docker image; the deployed server only serves `static_export/`.
* The pipeline is unchanged: 15' cutouts are ~146 px wide, the common grid is ~292 px (3.1"/px). Responses report the
  real `frame_shape` (e.g. `[292, 292]`), `large_shape` (~1024 px) and `image_format`: 6' targets stay PNG at 6x,
  15' targets are WebP scaled to ~1024 px (the `png_url_*` key names are kept for compatibility).
* `fov` now defaults to the cached field. Check it with `python scripts/check_large_field.py` (predicted vs measured
  star position per visit, and 6' vs 15' photometry).
* The wider field adds context (many more field stars), not resolution: the pixel scale and PSF are the same.

## Deploying (Render)

Render builds the `deploy` branch, which holds only what the Docker image needs (`Dockerfile`, `requirements.txt`, `render.yaml`,
`api/`, three files of `science/`, and `static_export/`) and no `cache/`, `cache_large/`, tests, scripts or frontend. After any backend
change (or a new `scripts/export_static.py` run): commit and push to `main`, then run **`scripts/update_deploy.sh`** (`--dry-run`
to preview, `--squash` to restart the branch's history as one commit). It builds the tree from git objects, never touches your
working tree, and only fast-forwards `deploy`. Frontend-only pushes to `main` need nothing.
