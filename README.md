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
cached target). If `cache/` is missing, the API serves `/frames` from that folder instead.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /health` | `{status, pipeline, cached_targets, static_targets}`; `pipeline` is `science.pipeline` or `fallback` |
| `GET /resolve?name=Barnard's Star` | `{name, key, ra, dec, source, cached}` - known targets from our table, others via CDS Sesame |
| `GET /frames?ra=&dec=&fov=` | `{target, ra, dec, fov_arcmin, pipeline, frames:[{index, url, mjd_start, mjd_end, n_images}]}`; each `url` is a PNG (north up, east left) |
| `GET /diff?ra=&dec=&fov=&a=&b=` | PNG difference of frames `a` and `b` (mid-grey = no change) |

`fov` is in arcmin. Responses only use data already in the cache - a request never triggers a download.
`/frames` uses `science.pipeline.build_frames` as soon as it is implemented (falling back to a simple
built-in stacker if it is missing or raises); `/diff` likewise uses `science.pipeline.difference`.
Sample responses for frontend work: `api/sample_frames.json` and `api/sample_frames/`.

## Data credits

Images are from the **SPHEREx** mission (NASA), obtained from the **NASA/IPAC Infrared Science Archive
(IRSA)**, which is operated by the California Institute of Technology under contract with NASA.
