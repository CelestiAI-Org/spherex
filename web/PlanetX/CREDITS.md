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
