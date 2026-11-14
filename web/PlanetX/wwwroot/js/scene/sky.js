import * as THREE from "./three.js";
import { NOISE3 } from "./glsl.js";
import { GALACTIC, radec } from "./util.js";

// The far sky (Milky Way, dust lanes, distant nebulae, unresolved star haze) is expensive to
// compute, so it is rendered once into an HDR cubemap and then used as the scene background.
// The black hole shader samples the same cubemap, so it lenses the real sky.

// Real positions (RA/Dec degrees), exaggerated in size and colour for drama.
const NEBULAE = [
    { ra: 271.0, dec: -24.4, radius: 7, a: [1.0, 0.22, 0.42], b: [0.35, 0.55, 1.0], power: 1.5 },  // Lagoon / Trifid
    { ra: 83.8, dec: -5.4, radius: 11, a: [1.0, 0.25, 0.35], b: [0.3, 0.6, 1.0], power: 1.6 },     // Orion
    { ra: 161.0, dec: -59.9, radius: 9, a: [1.0, 0.45, 0.25], b: [0.2, 0.85, 0.9], power: 1.5 },   // Carina
    { ra: 98.0, dec: 5.0, radius: 5, a: [1.0, 0.2, 0.3], b: [1.0, 0.55, 0.4], power: 1.1 },        // Rosette
    { ra: 314.7, dec: 44.5, radius: 9, a: [1.0, 0.25, 0.3], b: [0.9, 0.5, 0.3], power: 1.1 },      // North America (Cygnus)
    { ra: 246.8, dec: -24.4, radius: 7, a: [1.0, 0.75, 0.35], b: [0.3, 0.45, 1.0], power: 1.2 },   // Rho Ophiuchi
    { ra: 60.0, dec: 36.4, radius: 5, a: [1.0, 0.25, 0.32], b: [0.6, 0.3, 0.9], power: 0.9 },      // California
    { ra: 56.9, dec: 24.1, radius: 4, a: [0.45, 0.6, 1.0], b: [0.7, 0.8, 1.0], power: 1.0 },       // Pleiades reflection
];
const MAGELLANIC = [
    { ra: 80.9, dec: -69.75, radius: 5.5, power: 1.0 },
    { ra: 13.2, dec: -72.8, radius: 3.2, power: 0.7 },
];

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
    vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
#define NEB ${NEBULAE.length}
#define MAG ${MAGELLANIC.length}
uniform vec3 uGalN, uGalC, uGalY;
uniform vec3 uNebDir[NEB];
uniform vec3 uNebA[NEB];
uniform vec3 uNebB[NEB];
uniform vec2 uNebP[NEB];     // radius (rad), power
uniform vec3 uMagDir[MAG];
uniform vec2 uMagP[MAG];
uniform float uTexel;        // angular size of one cubemap texel
uniform float uHazeGain;     // keeps total haze light equal across cubemap sizes
varying vec3 vDir;
${NOISE3}

// Stars on a 3D lattice: each cell owns at most one star placed on the unit sphere. All 27
// neighbouring cells are checked, so stars are never clipped at cell borders. Bake-time only.
vec3 starLayer(vec3 d, float scale, float density, float bandBoost, float bright) {
    vec3 p = d * scale;
    vec3 base = floor(p);
    vec3 sum = vec3(0.0);
    float width = uTexel * 0.75 * scale;
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
        vec3 cell = base + vec3(x, y, z);
        vec3 h = hash33(cell);
        if (h.x > density * bandBoost) continue;
        vec3 sp = normalize(cell + 0.15 + h.yzx * 0.7) * scale;
        float dist = length(p - sp);
        float m = pow(hash13(cell + 7.3), 6.0);
        float temp = hash13(cell + 2.1);
        vec3 col = temp < 0.3 ? vec3(1.0, 0.72, 0.5) : temp < 0.7 ? vec3(1.0, 0.93, 0.82) : vec3(0.72, 0.8, 1.0);
        sum += col * (0.025 + m * bright) * exp(-dist * dist / (width * width));
    }
    return sum;
}

void main() {
    vec3 d = normalize(vDir);
    vec3 col = vec3(0.0012, 0.0016, 0.0032);

    // Galactic coordinates of this direction.
    float b = asin(clamp(dot(d, uGalN), -1.0, 1.0));
    float l = atan(dot(d, uGalY), dot(d, uGalC));
    float toCenter = 0.5 + 0.5 * cos(l);

    // --- Milky Way: a warped band of unresolved starlight, brighter toward the centre.
    float warp = fbm(d * 2.5 + 3.0, 4) - 0.5;
    float bandWidth = 0.13 + 0.07 * toCenter + 0.05 * warp;
    float bb = b - 0.025 * sin(l * 2.0) + 0.04 * warp;
    float band = exp(-bb * bb / (bandWidth * bandWidth));
    float halo = exp(-bb * bb / (0.55 * 0.55)) * 0.12;
    vec3 q = d * 5.0 + vec3(fbm(d * 3.0, 4), fbm(d * 3.0 + 9.0, 4), 0.0) * 1.6;
    float clouds = fbm(q, 6);
    float fine = fbm(d * 28.0, 4);
    float mw = (band * (0.06 + 2.6 * clouds * clouds * clouds) * (0.55 + 0.9 * fine) + halo * 0.6) * (0.3 + 1.0 * toCenter * toCenter);
    float bulge = exp(-(l * l) / (0.26 * 0.26) - (b * b) / (0.13 * 0.13));
    vec3 mwColor = mix(vec3(0.55, 0.64, 0.95), vec3(1.0, 0.86, 0.68), clamp(toCenter * toCenter * 0.9 + bulge, 0.0, 1.0));
    vec3 galaxyLight = mwColor * mw * 0.15 + vec3(1.0, 0.72, 0.45) * bulge * (0.06 + 0.7 * clouds * clouds);
    galaxyLight += vec3(1.0, 0.3, 0.45) * band * smoothstep(0.62, 0.8, fbm(d * 18.0 + 3.3, 4)) * 0.07;

    // Dust: the Great Rift down the middle of the band plus patchy clouds around it.
    float rift = exp(-pow((b + 0.012 + 0.03 * warp) / 0.03, 2.0)) * smoothstep(0.32, 0.7, fbm(d * 7.0 + 5.0, 5));
    float patches = exp(-b * b / (0.11 * 0.11)) * smoothstep(0.5, 0.78, fbm(d * 12.0 + 1.7, 5));
    float wisps = exp(-b * b / (0.25 * 0.25)) * smoothstep(0.62, 0.9, ridged(d * 6.0 + 2.0, 5)) * 0.5;
    float dust = clamp(rift * 1.1 + patches * 0.8 + wisps, 0.0, 0.94);
    vec3 transmission = mix(vec3(1.0), vec3(0.12, 0.07, 0.05), dust);
    col += galaxyLight * transmission;

    // --- Emission and reflection nebulae.
    for (int i = 0; i < NEB; i++) {
        float ang = acos(clamp(dot(d, uNebDir[i]), -1.0, 1.0));
        float r = ang / uNebP[i].x;
        if (r > 2.2) continue;
        vec3 np = d * 9.0 + float(i) * 13.7;
        vec3 w = vec3(fbm(np * 0.6, 4), fbm(np * 0.6 + 4.1, 4), fbm(np * 0.6 + 8.3, 4)) - 0.5;
        float n = fbm(np + w * 2.2, 6);
        float fil = ridged(np * 1.7 + w * 3.0, 5);
        float shape = exp(-r * r * 1.6) * smoothstep(0.25, 0.8, n + 0.35 * exp(-r * r));
        vec3 c = mix(uNebA[i], uNebB[i], smoothstep(0.35, 0.75, fbm(np * 0.8 + 2.0, 4)));
        float glow = shape * (0.5 + 1.2 * fil * fil);
        float darkLane = smoothstep(0.55, 0.8, fbm(np * 1.3 + 7.0, 5)) * exp(-r * r) * 0.75;
        col = col * (1.0 - darkLane) + c * glow * 0.22 * uNebP[i].y * (1.0 - darkLane * 0.6);
    }

    // --- Magellanic Clouds: grainy patches of unresolved stars.
    for (int i = 0; i < MAG; i++) {
        float ang = acos(clamp(dot(d, uMagDir[i]), -1.0, 1.0));
        float r = ang / uMagP[i].x;
        if (r > 2.5) continue;
        float n = fbm(d * 40.0 + float(i) * 3.0, 5);
        float cloud = exp(-r * r * 2.2) * (0.4 + 0.9 * n * n);
        col += vec3(0.72, 0.78, 1.0) * cloud * 0.045 * uMagP[i].y;
        col += vec3(1.0, 0.35, 0.5) * exp(-r * r * 2.2) * smoothstep(0.7, 0.85, n) * 0.06 * uMagP[i].y;
    }

    // --- Faint star haze; denser inside the band so it reads as resolved Milky Way stars.
    float boost = 1.0 + 4.0 * band * (1.0 - dust * 0.8);
    vec3 haze = vec3(0.0);
    haze += starLayer(d, 220.0, 0.06, boost, 0.5);
    haze += starLayer(d, 520.0, 0.03, boost, 0.25) * (0.3 + 0.7 * band);
    col += haze * uHazeGain;

    gl_FragColor = vec4(col, 1.0);
}`;

export function createSky(renderer, size) {
    const target = new THREE.WebGLCubeRenderTarget(size, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
    });
    const cubeCamera = new THREE.CubeCamera(1, 10, target);

    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        uniforms: {
            uGalN: { value: GALACTIC.north },
            uGalC: { value: GALACTIC.center },
            uGalY: { value: GALACTIC.y },
            uNebDir: { value: NEBULAE.map(n => radec(n.ra, n.dec)) },
            uNebA: { value: NEBULAE.map(n => new THREE.Vector3(...n.a)) },
            uNebB: { value: NEBULAE.map(n => new THREE.Vector3(...n.b)) },
            uNebP: { value: NEBULAE.map(n => new THREE.Vector2((n.radius * Math.PI) / 180, n.power)) },
            uMagDir: { value: MAGELLANIC.map(n => radec(n.ra, n.dec)) },
            uMagP: { value: MAGELLANIC.map(n => new THREE.Vector2((n.radius * Math.PI) / 180, n.power)) },
            uTexel: { value: Math.PI / 2 / size },
            uHazeGain: { value: Math.pow(size / 2048, 1.5) },
        },
    });
    const bakeScene = new THREE.Scene();
    bakeScene.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), material));
    bakeScene.add(cubeCamera);

    // Bake one face per call so no single frame stalls the GPU for long.
    let face = 0;
    function bakeStep() {
        if (face >= 6) return true;
        if (face === 0) {
            cubeCamera.coordinateSystem = renderer.coordinateSystem;
            cubeCamera.updateCoordinateSystem();
            cubeCamera.updateMatrixWorld(true);
        }
        const previous = renderer.getRenderTarget();
        target.texture.generateMipmaps = face === 5;
        renderer.setRenderTarget(target, face);
        renderer.render(bakeScene, cubeCamera.children[face]);
        renderer.setRenderTarget(previous);
        face++;
        if (face === 6) {
            material.dispose();
            bakeScene.children[0].geometry.dispose();
        }
        return face >= 6;
    }

    return { texture: target.texture, target, bakeStep };
}
