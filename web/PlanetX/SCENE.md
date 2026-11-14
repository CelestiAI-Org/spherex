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
| `?quality=low\|medium\|high` | Locks a tier. Otherwise the tier is picked from the GPU name and the governor lowers resolution, then the tier, if the frame rate drops below about 48 fps. |
| `?fps` or **Shift+F** | FPS, tier and resolution overlay. |
| `?debug` | Exposes tuning handles on `spherexScene.debug`. |
| `?wiring=off` | Turns off the demo wiring. |

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
