# Credits — SPHEREx Explorer sky scene

All visuals in `wwwroot/js/space.js` and `wwwroot/js/scene/` are procedural and written for this
project. No photographs, film assets or music are used. The libraries, code and ideas below are
what the scene builds on.

## Sound

All sound is synthesised live in `scene/audio.js` with the browser's Web Audio API (oscillators,
filtered noise, delays). There are no audio samples, recordings or music, and nothing is borrowed
from any film or game.

## Library

| What | Licence | Used for |
| --- | --- | --- |
| [three.js](https://github.com/mrdoob/three.js) r170, loaded from the jsDelivr CDN | MIT | WebGL renderer, scene graph, maths |

## Code adapted (with licence)

| Source | Licence | Where |
| --- | --- | --- |
| "Hash without Sine", Dave Hoskins ([Shadertoy 4djSRW](https://www.shadertoy.com/view/4djSRW)) | MIT | `scene/glsl.js`: `hash13`, `hash33`, `hash12` |

## Techniques and references (ideas only, no code copied)

| Reference | Used for |
| --- | --- |
| Jorge Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare" (SIGGRAPH 2014) | 13-tap bloom downsample, Karis-average firefly filter, tent upsample (`scene/post.js`) |
| John Chapman, "Pseudo Lens Flare" (2013 blog post) | Ghosts and halo built from the bloom buffer (`scene/post.js`) |
| Krzysztof Narkowicz, "ACES Filmic Tone Mapping Curve" (2016 blog post) | Tone-mapping curve fit (`scene/glsl.js`) |
| IAU J2000 galactic coordinate definition (north galactic pole RA 192.85948°, Dec 27.12825°; centre RA 266.40510°, Dec −28.93617°) | Places the Milky Way band at its real position (`scene/util.js`, `scene/sky.js`) |
| Real sky positions of the Lagoon, Orion, Carina, Rosette, North America, Rho Ophiuchi, California and Pleiades nebulae; the Magellanic Clouds; M31, M33, M51, M101, M104, M87, M49 | Placement of the nebulae and galaxies (sizes exaggerated for effect) |
| Logarithmic-spiral arm model and the Sérsic (de Vaucouleurs) profile | Spiral and elliptical galaxy shaders (`scene/galaxies.js`) |
| Dan Greenheck, ["Raytracing a Black Hole with WebGPU"](https://threejsroadmap.com/blog/raytracing-a-black-hole-with-webgpu) (2026); companion repo [dgreenheck/webgpu-black-hole](https://github.com/dgreenheck/webgpu-black-hole) is MIT | Inspiration for a real-time ray-marched black hole with a thin, beamed accretion disk. No code taken: our lensing integrates the exact Schwarzschild orbit equation in WebGL2 (`scene/blackhole.js`) |
| Schwarzschild photon-orbit (Binet) equation u″ + u = (3/2) r_s u², and the weak-field deflection angle 2 r_s / b (standard general relativity) | Lensing integration and the seamless far-field bending (`scene/blackhole.js`) |
| O. James, E. von Tunzelmann, P. Franklin, K. S. Thorne, "Gravitational lensing by spinning black holes in astrophysics, and in the movie *Interstellar*", Class. Quantum Grav. 32 (2015) 065001 | Visual reference for how a lensed thin disk looks (far side over the top, photon ring). No images or code used |
| Thin-disk radiative flux F ∝ r⁻³(1 − √(r_in/r)) with the inner edge at the Schwarzschild ISCO (3 r_s), temperature T ∝ F^(1/4) (Shakura–Sunyaev / Novikov–Thorne form), relativistic Doppler factor g = √(1 − r_s/r) / (γ(1 − β cos θ)) and beaming ∝ g³ | Accretion disk brightness, observed colour (receding side redder, approaching side blue-white) (`scene/blackhole.js`) |
| Sergei Winitzki, "A handy approximation for the error function and its inverse" (2008), a = 0.147 | Exact per-step integral of the disk's Gaussian glow sheet, so the glow never shows step artefacts (`scene/blackhole.js`) |
| Texture level-of-detail from the projected pixel footprint (standard texture-filtering practice) | Explicit noise mip levels on the edge-on disk, where automatic derivatives inside the ray loop are unreliable (`scene/blackhole.js`) |
| Flow-map style two-phase texture advection (common real-time technique) | Keeps the differentially rotating disk turbulence from winding up (`scene/blackhole.js`) |
| Tidal disruption of a body falling into a black hole (spaghettification), radial free fall r ∝ (t₀ − t)^(2/3) with conserved angular momentum, and Keplerian spiralling of the debris (standard astrophysics) | The looping asteroid event: fall, tidal stretching and heating, debris stream that flares at the inner edge (`scene/blackhole.js`) |
| Sphere tracing of signed distance fields (J. C. Hart, "Sphere tracing", The Visual Computer, 1996), tetrahedral-difference normals, and noise-displaced shapes with bowl craters (common procedural technique) | The tumbling asteroid, traced inside the lensing shader (`scene/blackhole.js`) |
| Core-collapse supernova sequence (red-supergiant swelling, core collapse, shock breakout, expanding filamentary remnant), shown qualitatively and compressed in time | The intro's story beats and captions (`scene/intro.js`) |
| Quadratic limb-darkening law and granulation as noise cells (standard stellar-surface rendering ideas) | The star's surface (`scene/intro.js`) |
| Disk precession around spinning black holes (Lense–Thirring effect), used qualitatively | The slow wobble of the disk's tilt and roll (`scene/blackhole.js`) |
