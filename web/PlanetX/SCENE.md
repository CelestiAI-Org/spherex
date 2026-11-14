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
4. Restart `dotnet run` (the server only picks up new files on start) and hard-reload.

What the page does with them:

- A missing file is skipped and its caption still shows. The browser's console will list a 404
  for each missing file; that is expected and harmless.
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
