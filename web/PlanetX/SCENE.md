# Sky scene — notes for the team

The background is a procedural Three.js scene (`wwwroot/js/space.js` plus `wwwroot/js/scene/`).
It mounts into `#sky-scene`; the observation workspace is a separate HTML layer.

## Integration contract

`space.js` exports `scene` (also available as `window.spherexScene`):

| Call | What it does |
| --- | --- |
| `scene.ready` | Promise that resolves once the sky is baked and fading in. |
| `scene.flyTo(target, { minDuration = 3.2 })` | Starts the warm zoom toward `target = { ra, dec }` (degrees), or toward a Promise of one, such as a name lookup through `/api/spherex/resolve`. Resolves after the minimum time; the warp keeps cruising until `finish()`, so a slow API is hidden. |
| `scene.finish()` / `scene.showFrames()` | Waits for the minimum flight time, then decelerates, flashes on arrival and dims the sky for the data panels. Resolves on arrival: show your data view then. |
| `scene.reset()` | Fades back to the opening view, e.g. for "Back to sky". |
| `scene.onPick(fn)` | `fn({ key, name, ra, dec })` runs when a target beacon is clicked. Returns an unsubscribe function. |
| `scene.quality`, `scene.setQuality("low" \| "medium" \| "high")` | Read or lock the quality tier. |

Typical use:

```js
import { scene } from "./space.js";
await Promise.all([scene.flyTo(target), fetch(`/api/spherex/frames?target=${encodeURIComponent(key)}`)]);
await scene.finish();      // now open the viewer
// later
scene.reset();
```

A newer call cancels an older one, so calling `reset()` mid-flight is safe. Without WebGL2 the
same calls still resolve, on a 2D fallback sky.

## Viewer wiring

`scene/wiring.js` connects the existing target form to the contract. It resolves the name, flies
there, loads cached frames, spectrum, detector and band data, then opens the observation
workspace. Disable this integration with `?wiring=off` when working on the scene alone.

## URL flags and keys

| Flag / key | Effect |
| --- | --- |
| `?quality=low\|medium\|high` | Locks a tier. Without it the start tier comes from the GPU name: medium by default, high only for strong discrete GPUs, low for software renderers and phones. |
| `?fps` or **Shift+F** | Overlay: fps, tier, render resolution, the black hole's buffer size and resolution scale, steps, octaves, and the governor's last step down. |
| `?debug` | Exposes tuning handles on `spherexScene.debug`. |
| `?wiring=off` | Turns off the demo wiring. |
| `?asteroid=off` | Turns off the looping asteroid that falls into the black hole. |

## Automatic quality fallback

If the frame rate stays below 45 fps for about 3 seconds, the scene steps down once, waits, then
checks again. The order is: lower the black hole's resolution scale (to 0.5 or 0.6); then drop one
tier; then, already on low, lower the overall render resolution (to 0.7). It never steps back up.

| Tier | Black hole resolution scale | RK4 steps per ray | Noise octaves |
| --- | --- | --- | --- |
| low | 0.5 | 44 | 2 |
| medium (default) | 0.6 (down to 0.5) | 64 | 3 |
| high | 0.85 (down to 0.6) | 110 | 4 |

## Files

| File | Contents |
| --- | --- |
| `scene/sky.js` | HDR cubemap baked once: Milky Way at its real galactic position, dust, nebulae, star haze. |
| `scene/stars.js` | Parallax star shells, twinkle, hero stars with spikes. |
| `scene/galaxies.js` | Instanced spiral and elliptical galaxies, hero spiral. |
| `scene/nebulae.js` | Layered volumetric-looking clouds. |
| `scene/blackhole.js` | Lensing black hole: Schwarzschild ray integration, accretion disk, photon ring. |
| `scene/asteroids.js` | Debris belt and drifting dust. |
| `scene/warp.js`, `scene/flight.js` | Warp streaks, beacons, and the flight state machine. |
| `scene/targets.js` | Cached target beacons, labels and picking. |
| `scene/post.js` | Bloom, flare, streak, chromatic aberration, tone mapping, grade, vignette, grain. |
| `scene/camera.js` | Drag with inertia, idle drift, parallax, zoom. |
| `scene/quality.js` | Quality tiers and the frame-rate governor. |
| `scene/fallback.js` | 2D sky without WebGL2. |

## Dev gotcha: stale files after edits

`MapStaticAssets` builds its file manifest (with ETags) when the app starts. After editing JS or
CSS, restart `dotnet run` and hard-reload (Ctrl+Shift+R). Otherwise the browser can keep an old
copy of a module.

Credits and licences: see `CREDITS.md`.

## Observation workspace

`wwwroot/js/viewer.js` owns the HTML observation workspace in `Views/Home/Index.cshtml`.
`scene/wiring.js` collapses Targets when a flight starts, loads data through
`/api/spherex/*`, and opens the workspace after arrival. The Python backend is unchanged;
`Controllers/SpherexController.cs` forwards API requests and resolves image URLs.
Configure the upstream with `SpherexApi:BaseUrl` (or `SpherexApi__BaseUrl`).

The desktop workspace has a 12.5vh inset on all sides, a 6:1 main/control split,
and a 1:2 information/image split. Small screens scroll/reflow rather than hide controls.
Timeline indices refer to actual visits: Single shows one; Compare alternates the two
selected visits every 500 ms; Timelapse loops all visits in the inclusive selected range.
The pause control stops automatic playback. Returning to sky stops the timer.

The control bar has Image type / Image selection / Display sections. Time mode uses
an abbreviated date slider, selected observation interval, Colour/Grayscale selection,
and Single/Compare/Timelapse. Band mode replaces these with a wavelength-coloured
slider and the selected band edges. Detector mode shows numbered buttons and coverage.
Detector and spectral-band images stack all visits and hide time-only display controls. Missing bands retain their discrete slider positions;
unavailable detectors remain visible but disabled. Default view: latest epoch in colour.

The preview uses smooth browser image scaling, dynamic image dimensions, wheel zoom
(1–8x), bounded dragging, and keyboard +/- / arrows / 0. Colour images are preferred.
The spectrum is real API flux versus wavelength; the colour strip is a false-colour
wavelength guide, not visible-light colour measurement. No predicted position is invented.
The spectrum follows the current epoch; Compare overlays A/B with stable axes, and
Timelapse updates with each displayed frame. Band mode highlights the selected wavelength
interval over the complete spectrum; Detector mode highlights that detector's points.
Hollow markers flag saturated measurements, explained by the upper-right legend. The current date, band, detector or Image A/B sits below the spectrum title. The wavelength colour guide and tick labels share the chart SVG coordinate system for alignment. The desktop control bar uses two aligned rows; playback modes sit beside Observation time and the active date sits beside the slider. A selection with no measurements is explicitly
empty, never replaced by other epochs. Share links restore image type, epoch/range,
playback mode, colour/grayscale, band and detector selection.

### UI regression check

With .NET 10 and Python Playwright installed, build PlanetX and run
`web/tests/viewer_smoke.py` with the application at localhost:5189 and
`SpherexApi__BaseUrl=http://127.0.0.1:5190/`. The test hosts checked-in exports on 5190
and tests menu collapse, layout ratios, date modes, zoom/pan, detector/band selection,
share round-trip and mobile overflow. The browser uses the fallback sky to keep the
check independent of GPU performance; it does not test Three.js shader appearance.
