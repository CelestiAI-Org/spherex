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
Names match the five cached targets loosely (case, spaces and punctuation ignored, plus aliases
such as "Eps Indi B", "WISE 0855", "RW Aur" in `scene/targets.js`). Coordinates, or a resolved name
with no cached key, ask `/frames?ra=&dec=`, which opens the nearest cached target within 10 arcmin.
Band images are only requested for targets that `/targets` lists with `has_bands`.

## URL flags and keys

| Flag / key | Effect |
| --- | --- |
| `?quality=low\|medium\|high` | Locks a tier. Without it the start tier comes from the GPU name: medium by default, high only for strong discrete GPUs, low for software renderers and phones. |
| `?fps` or **Shift+F** | Overlay: fps, tier, render resolution, the black hole's buffer size and resolution scale, steps, octaves, and the governor's last step down. |
| `?debug` | Exposes tuning handles on `spherexScene.debug`. |
| `?wiring=off` | Turns off the demo wiring. |
| `?intro=off` | Skips the supernova intro (it otherwise plays on every page load). |
| `?gate=0` | Skips the "Click to begin" screen: the intro starts at once and sound joins at the first interaction. |
| `?sound=off` | Disables sound and hides the sound button. |
| `?asteroid=on` | Turns on the looping asteroid that falls into the black hole (off by default). |

## Supernova intro and sound

`scene/intro.js` plays a 28-second opening on every page load, then hands over to the idle black
hole shot. A "Click to begin" screen comes first, because browsers only allow sound after a click;
that one click starts the picture and the sound together.

| Time | What happens |
| --- | --- |
| 0-5 s | A massive blue-white star; slow push-in. |
| 5-10 s | It swells, reddens, pulses faster and shudders. |
| 10-12 s | Core collapse: it shrinks and dims, light is pulled inward, a held beat. |
| 12-17 s | Supernova: one flash, an expanding shell of gas, a shockwave ripple that pushes the rocks and dust; the camera pulls back. |
| 17-20.5 s | The gas thins, the camera pushes in, the core shrinks to a point and winks out. |
| 20-28 s | Light starts to bend, the photon ring ignites, the disk lights from its inner edge outward; the camera pulls back and glides to the idle shot. |

- **Skipping:** the Skip button, Esc or Space; any menu action, search, target pick, or a call to
  `scene.flyTo()` / `scene.reset()` skips it at once (also during the "Click to begin" screen), so
  it never delays the warm zoom. "Replay intro" in the menu (or `scene.replayIntro()`) plays it again.
- **Sound** (`scene/audio.js`) is synthesised with the Web Audio API: no samples or music files.
  The sound button (bottom right) turns it on or off and the choice is remembered. After the intro
  a quiet ambient pad keeps playing. The master level is about -12 dB behind a limiter, and audio
  is suspended while the tab is hidden. With `?gate=0` the intro starts at once and sound joins at
  the first click or key press.
- **Comfort:** one flash that ramps over 300 ms, pulses below 2 per second, no strobing. With
  `prefers-reduced-motion` the camera stays still, there is no flash wash, ripple, heartbeat or
  whoosh, and sound plays at about a third of the level.
- **Tiers:** low gets a simpler shell, fewer ejecta, no ripple refraction, and fewer voices in
  the drone, shimmer and pad.

### Voiceover (optional)

The intro can play recorded voice lines. The captions and cue times are in `LINES` at the top of
`wwwroot/js/scene/intro.js`; volume and ducking are in `VOICE` just below it.

| File | Starts at | Caption | Time before the next line |
| --- | --- | --- | --- |
| `line1.mp3` | 0.5 s | A massive star reaches the end of its life. | 5.2 s |
| `line2.mp3` | 6 s | Its core can no longer hold. | 6.2 s |
| `line3.mp3` | 12.5 s | A supernova outshines a whole galaxy for a few weeks. | 6.2 s |
| `line4.mp3` | 19 s | Gravity crushes what is left of the core. | 3.7 s |
| `line5.mp3` | 23 s | What remains can be a black hole. | 4.7 s |

How to record and add them:

1. Record each line as its own file, mono, in a quiet room, with no music under it. Trim the
   silence at both ends and normalise each file to about -3 dB peak so the lines match in volume.
2. Keep each line shorter than its "time before the next line" above. Line 4 has the shortest
   slot (3.7 s). You may say different words from the captions; then edit the caption text in
   `LINES` to match.
3. Export as MP3 named `line1.mp3` to `line5.mp3` and put them in `wwwroot/audio/voice/`.
   List the files you added in `wwwroot/audio/voice/voice.json`, e.g.
   `{ "files": ["line1.mp3", "line2.mp3", "line3.mp3", "line4.mp3", "line5.mp3"] }`.
4. Restart `dotnet run` (the server only picks up new files on start) and hard-reload.

What the page does with them:

- A line not listed in `voice.json` is skipped without a request, and its caption still shows.
- While a line plays, the music and effects dip by about 9 dB and come back afterwards. The voice
  goes through the same limiter and master volume as everything else.
- A caption stays on screen for as long as its line is being spoken.
- Lines never overlap. If one is longer than its slot, the next line waits until it has finished,
  and the console prints which file to shorten, for example
  `[intro voice] line2.mp3 is 7.5 s but its slot is 6.2 s`.
- Skip stops the voice at once. If the intro ends on its own, the last line is allowed to finish.

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
| `scene/intro.js`, `scene/audio.js` | Supernova intro timeline and visuals; synthesised sound. |
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
`SpherexApi__BaseUrl=http://127.0.0.1:5190/` (also set `ASPNETCORE_ENVIRONMENT=Development`
when not using a launch profile, or static files are not served). The Targets menu starts closed,
so the test opens it first. The test hosts checked-in exports on 5190
and tests menu collapse, layout ratios, date modes, zoom/pan, detector/band selection,
share round-trip and mobile overflow. The browser uses the fallback sky to keep the
check independent of GPU performance; it does not test Three.js shader appearance.

## Deploying the frontend (Render, second web service)

The frontend runs as its own Render web service built from the `deploy-web` branch, which holds only
`web/Dockerfile`, `web/.dockerignore` and `web/PlanetX/` (about 300 KiB, no history from main).
After a frontend change: push to main, then run `scripts/update_deploy_web.sh` (it does nothing if no
frontend file changed; `--dry-run` shows what it would commit). It never touches `deploy` or main.

- Image: `docker build -t spherex-web web && docker run -e PORT=8080 -p 8080:8080 spherex-web`.
- Listens on `0.0.0.0:$PORT`. `GET /health` answers `{"status":"ok"}` without calling the science API.
- The proxy's upstream comes from `SpherexApi:BaseUrl` in `appsettings.json`
  (`https://spherex-api-cpln.onrender.com/`); override it with the env var `SpherexApi__BaseUrl`.
- `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` (set in the image) makes the app see Render's HTTPS, so
  `UseHttpsRedirection` never redirects or loops. `AllowedHosts` is `*`, so a custom domain needs no setting.
