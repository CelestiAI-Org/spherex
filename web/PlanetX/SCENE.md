# Sky scene — notes for the team

The background is a procedural Three.js scene (`wwwroot/js/space.js` plus `wwwroot/js/scene/`).
It mounts into `#sky-scene` and does not change `api.js`, `ui.js` or the page markup.

## Integration contract

`space.js` exports `scene` (also available as `window.spherexScene`):

| Call | What it does |
| --- | --- |
| `scene.ready` | Promise that resolves once the sky is baked and fading in. |
| `scene.flyTo(target, { minDuration = 3.2 })` | Starts the warm zoom toward `target = { ra, dec }` (degrees), or toward a Promise of one, such as `api.resolveName(...)`. Resolves after the minimum time; the warp keeps cruising until `finish()`, so a slow API is hidden. |
| `scene.finish()` / `scene.showFrames()` | Waits for the minimum flight time, then decelerates, flashes on arrival and dims the sky for the data panels. Resolves on arrival: show your data view then. |
| `scene.reset()` | Fades back to the opening view, e.g. for "Back to sky". |
| `scene.onPick(fn)` | `fn({ key, name, ra, dec })` runs when a target beacon is clicked. Returns an unsubscribe function. |
| `scene.quality`, `scene.setQuality("low" \| "medium" \| "high")` | Read or lock the quality tier. |

Typical use:

```js
import { scene } from "./space.js";
await Promise.all([scene.flyTo(target), api.getFrames(key)]);
await scene.finish();      // now open the viewer
// later
scene.reset();
```

A newer call cancels an older one, so calling `reset()` mid-flight is safe. Without WebGL2 the
same calls still resolve, on a 2D fallback sky.

## Demo wiring (temporary)

`scene/wiring.js` connects the existing target form to the contract. It resolves the name, flies
there, loads frames for cached targets and shows the first frame in `#viewer`, so the flight can be
demoed today. Disable it with `?wiring=off`, and delete the file plus its import in `space.js` once
the real integration is in place.

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
