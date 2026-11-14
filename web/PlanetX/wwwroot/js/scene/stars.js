import * as THREE from "./three.js";
import { galactic, gaussian, rng } from "./util.js";

// Linear-light colours for stellar spectral classes and how common each is among
// naked-eye-ish stars (O/B rare but bright, K/M common but dim).
const CLASSES = [
    { weight: 0.04, color: [0.58, 0.7, 1.0], lum: 2.2 },   // O/B blue-white
    { weight: 0.09, color: [0.78, 0.85, 1.0], lum: 1.6 },  // A white
    { weight: 0.14, color: [1.0, 0.97, 0.92], lum: 1.2 },  // F
    { weight: 0.18, color: [1.0, 0.89, 0.72], lum: 1.0 },  // G (Sun-like)
    { weight: 0.27, color: [1.0, 0.75, 0.5], lum: 0.85 },  // K orange
    { weight: 0.28, color: [1.0, 0.6, 0.4], lum: 0.65 },   // M red
];
function pickClass(random) {
    let x = random();
    for (const c of CLASSES) {
        if ((x -= c.weight) <= 0) return c;
    }
    return CLASSES[CLASSES.length - 1];
}

function randomDirection(random, out, bandFraction) {
    if (random() < bandFraction) {
        // Concentrated toward the galactic plane and centre, like the real Milky Way.
        const l = random() < 0.6 ? gaussian(random) * 0.9 : (random() * 2 - 1) * Math.PI;
        const b = gaussian(random) * 0.14;
        return galactic(l, b, out);
    }
    const y = random() * 2 - 1;
    const t = random() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    return out.set(r * Math.cos(t), y, r * Math.sin(t));
}

const pointVertex = /* glsl */ `
attribute vec3 color;
attribute vec3 star;          // x: size (px at 1080p), y: brightness, z: twinkle phase
uniform float uTime, uPxScale, uTwinkle, uBoost;
uniform vec3 uBhPos;
uniform vec2 uBhCone;       // cos of inner / outer angle of the black hole lensing cone
varying vec3 vColor;
varying float vBright;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float phase = star.z;
    float tw = 1.0 + uTwinkle * (0.22 * sin(uTime * (0.7 + fract(phase) * 2.3) + phase * 6.283)
                               + 0.12 * sin(uTime * (2.9 + fract(phase * 7.0) * 3.0) + phase * 3.1));
    float nearBoost = clamp(220.0 / -mv.z, 0.75, 2.2);   // nearer stars a touch larger: parallax cue
    float size = star.x * uPxScale * nearBoost;
    float drawn = max(size, 2.0);
    gl_PointSize = drawn;
    // Inside the strong-lensing cone the ray tracer draws its own (bent) stars, so fade these out.
    float toHole = dot(normalize(position - cameraPosition), normalize(uBhPos - cameraPosition));
    float lensFade = 1.0 - smoothstep(uBhCone.y, uBhCone.x, toHole);
    vBright *= lensFade;
    if (lensFade <= 0.0) gl_PointSize = 0.0;
    // Keep total light constant when a tiny star is drawn larger than its true size.
    vBright = star.y * tw * uBoost * (size * size) / (drawn * drawn) * 2.4 / (1.0 + size * 0.1);
    vColor = color;
}`;

const pointFragment = /* glsl */ `
varying vec3 vColor;
varying float vBright;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 14.0);
    float halo = exp(-r2 * 4.0) * 0.18;
    gl_FragColor = vec4(vColor * vBright * (core + halo), 1.0);
}`;

const heroFragment = /* glsl */ `
varying vec3 vColor;
varying float vBright;
uniform float uSpikes;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    float core = exp(-r2 * 60.0) * 2.0;
    float glow = exp(-r2 * 9.0) * 0.35 + exp(-sqrt(r2) * 5.0) * 0.12;
    // Four soft diffraction spikes, fading to nothing at the sprite edge.
    float fade = 1.0 - smoothstep(0.35, 1.0, sqrt(r2));
    float spikes = (exp(-abs(c.x) * 70.0) * exp(-abs(c.y) * 2.6) + exp(-abs(c.y) * 70.0) * exp(-abs(c.x) * 2.6)) * fade;
    float a = core + glow + spikes * uSpikes;
    gl_FragColor = vec4(vColor * vBright * a * 0.25, 1.0);
}`;

function buildPoints({ count, seed, minDist, maxDist, bandFraction, sizeRange, brightRange, hero }) {
    const random = rng(seed);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const star = new Float32Array(count * 3);
    const dir = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
        randomDirection(random, dir, bandFraction);
        const dist = minDist * Math.pow(maxDist / minDist, random());
        positions.set([dir.x * dist, dir.y * dist, dir.z * dist], i * 3);
        const cls = pickClass(random);
        // Slight per-star colour variation keeps it from looking quantised.
        const jitter = 0.92 + random() * 0.16;
        colors.set(cls.color.map(v => Math.min(1, v * jitter)), i * 3);
        const m = Math.pow(random(), hero ? 2.0 : 7.0);
        star[i * 3] = sizeRange[0] + (sizeRange[1] - sizeRange[0]) * m;
        star[i * 3 + 1] = (brightRange[0] + (brightRange[1] - brightRange[0]) * m) * cls.lum;
        star[i * 3 + 2] = random() * 10;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("star", new THREE.BufferAttribute(star, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), maxDist * 1.1);
    return geometry;
}

export function createStars(uniforms) {
    const group = new THREE.Group();
    const material = (fragmentShader, extra = {}) => new THREE.ShaderMaterial({
        vertexShader: pointVertex,
        fragmentShader,
        uniforms: { ...uniforms, uBoost: { value: 1 }, ...extra },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });

    // Three depth shells. As the camera drifts, the near shell slides against the far one.
    const shells = [
        { count: 9000, seed: 101, minDist: 60, maxDist: 220, bandFraction: 0.2, sizeRange: [1.4, 5.5], brightRange: [0.5, 5.0] },
        { count: 16000, seed: 202, minDist: 220, maxDist: 900, bandFraction: 0.35, sizeRange: [1.2, 4.5], brightRange: [0.18, 3.5] },
        { count: 22000, seed: 303, minDist: 900, maxDist: 2400, bandFraction: 0.55, sizeRange: [1.0, 3.2], brightRange: [0.12, 2.2] },
    ];
    const layers = shells.map(cfg => {
        const points = new THREE.Points(buildPoints(cfg), material(pointFragment));
        points.frustumCulled = false;
        points.renderOrder = 1;
        points.userData.total = cfg.count;
        group.add(points);
        return points;
    });

    const heroMaterial = material(heroFragment, { uSpikes: { value: 1 } });
    const hero = new THREE.Points(
        buildPoints({ count: 140, seed: 404, minDist: 120, maxDist: 700, bandFraction: 0.4, sizeRange: [22, 64], brightRange: [1.5, 8.0], hero: true }),
        heroMaterial,
    );
    hero.frustumCulled = false;
    hero.renderOrder = 1;
    hero.userData.total = 140;
    group.add(hero);

    function setTier(tier) {
        for (const layer of layers) layer.geometry.setDrawRange(0, Math.floor(layer.userData.total * tier.stars));
        hero.geometry.setDrawRange(0, Math.floor(hero.userData.total * tier.heroStars));
    }
    function setBoost(value) {
        group.children.forEach(child => { child.material.uniforms.uBoost.value = value; });
    }

    return { group, setTier, setBoost };
}
