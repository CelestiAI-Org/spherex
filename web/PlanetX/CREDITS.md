# Credits — SPHEREx Explorer sky scene

All visuals in `wwwroot/js/space.js` and `wwwroot/js/scene/` are procedural and written for this
project. No photographs, film assets or music are used. The libraries, code and ideas below are
what the scene builds on.

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
| Thin-disk temperature profile T ∝ r^(−3/4)(1 − √(r_in/r))^(1/4) (Shakura–Sunyaev / Novikov–Thorne form), relativistic Doppler factor and gravitational redshift | Accretion disk colour and brightness (`scene/blackhole.js`) |
| Flow-map style two-phase texture advection (common real-time technique) | Keeps the differentially rotating disk turbulence from winding up (`scene/blackhole.js`) |
