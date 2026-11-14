import * as THREE from "./three.js";
import { DEG, GALACTIC, radec, rng } from "./util.js";

// Every galaxy is one instance of a single quad drawn with a procedural shader (spiral or
// elliptical), so all of them cost one draw call. The hero spiral also gets a cloud of
// sparkling points so it holds up when you look closely.

const SPIRAL = 0, ELLIPTICAL = 1;
const W = [0.62, 0.74, 1.0];      // young-star blue-white
const Y = [1.0, 0.82, 0.58];      // old-star core gold

const NAMED = [
    // Hero spiral: fictional placement so it sits in the opening shot.
    { ra: 243, dec: 3, dist: 800, radius: 125, type: SPIRAL, arms: 2, wind: 2.6, incl: 52, pa: 30, bright: 1.0, core: Y, arm: W, hero: true },
    { ra: 10.68, dec: 41.27, dist: 900, radius: 120, type: SPIRAL, arms: 2, wind: 2.2, incl: 74, pa: 38, bright: 0.85, core: Y, arm: [0.7, 0.78, 1.0] },   // Andromeda
    { ra: 23.46, dec: 30.66, dist: 900, radius: 42, type: SPIRAL, arms: 2, wind: 1.8, incl: 50, pa: 20, bright: 0.6, core: [0.9, 0.85, 0.8], arm: W },  // Triangulum
    { ra: 202.47, dec: 47.2, dist: 1000, radius: 34, type: SPIRAL, arms: 2, wind: 2.8, incl: 20, pa: 0, bright: 0.8, core: Y, arm: W },                // Whirlpool
    { ra: 210.8, dec: 54.35, dist: 1000, radius: 38, type: SPIRAL, arms: 4, wind: 2.0, incl: 10, pa: 0, bright: 0.65, core: Y, arm: W },               // Pinwheel
    { ra: 190.0, dec: -11.62, dist: 1000, radius: 30, type: SPIRAL, arms: 2, wind: 3.5, incl: 84, pa: 90, bright: 0.9, core: [1.0, 0.86, 0.62], arm: [1.0, 0.9, 0.75] }, // Sombrero
    { ra: 187.7, dec: 12.39, dist: 1000, radius: 22, type: ELLIPTICAL, axis: 0.9, bright: 0.9, core: [1.0, 0.85, 0.66] },                               // M87
    { ra: 187.44, dec: 8.0, dist: 1000, radius: 17, type: ELLIPTICAL, axis: 0.7, bright: 0.7, core: [1.0, 0.86, 0.7] },                                // M49
];

const vertexShader = /* glsl */ `
attribute vec4 aParams;   // type, arms | axis ratio, wind, seed
attribute vec3 aCore;
attribute vec3 aArm;
uniform float uFadeNear;
varying vec2 vUv;
varying vec4 vParams;
varying vec3 vCore;
varying vec3 vArm;
varying float vFade;
void main() {
    vUv = uv;
    vParams = aParams;
    vCore = aCore;
    vArm = aArm;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vFade = smoothstep(uFadeNear * 0.4, uFadeNear, distance(centre, cameraPosition));
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying vec4 vParams;
varying vec3 vCore;
varying vec3 vArm;
varying float vFade;
void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0 || vFade <= 0.0) discard;
    float seed = vParams.w;
    vec3 col;
    if (vParams.x < 0.5) {
        float arms = vParams.y, wind = vParams.z;
        float th = atan(p.y, p.x) - uTime * 0.004 * (1.0 + seed * 0.1);
        vec2 q = p * 0.9 + seed;
        float n = texture2D(uNoise, q * 0.45).r;
        float n2 = texture2D(uNoise, q * 1.6 + 0.3).g;
        float n3 = texture2D(uNoise, q * 3.3 + 0.7).a;
        float ph = arms * (th - wind * log(max(r, 0.03)));
        float wob = (n - 0.5) * 2.6;
        float arm = pow(0.5 + 0.5 * cos(ph + wob), 2.4);
        float lane = pow(0.5 + 0.5 * cos(ph - 0.85 + wob), 9.0) * smoothstep(0.06, 0.22, r) * smoothstep(1.0, 0.55, r);
        float disk = exp(-r * 3.0);
        float bulge = exp(-pow(r / 0.06, 0.9)) * 1.4 + 0.45 * exp(-r / 0.16);
        float knots = smoothstep(0.8, 0.97, n3) * smoothstep(0.4, 0.8, n2) * arm * smoothstep(0.1, 0.3, r) * smoothstep(1.0, 0.45, r);
        float clusters = smoothstep(0.72, 0.95, n2) * arm * disk;
        col = vArm * disk * (0.2 + 2.6 * arm * (0.55 + 0.8 * n2));
        col *= 1.0 - lane * 0.85;
        col += vCore * bulge * 1.3;
        col += vec3(1.0, 0.3, 0.5) * knots * 1.1;
        col += vec3(0.6, 0.75, 1.0) * clusters * 1.6;
        col *= smoothstep(1.0, 0.72, r);
    } else {
        vec2 e = vec2(p.x, p.y / vParams.y);
        float re = length(e);
        float sersic = exp(-7.67 * (pow(max(re, 1e-3) / 0.2, 0.25) - 1.0));
        col = vCore * min(sersic, 60.0) * 0.012 * smoothstep(1.0, 0.55, re);
    }
    gl_FragColor = vec4(col * vFade, 1.0);
}`;

const pointVertex = /* glsl */ `
attribute vec4 aStar;     // size, brightness, phase, unused
attribute vec3 color;
uniform float uTime, uPxScale;
varying vec3 vColor;
varying float vBright;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = aStar.x * uPxScale;
    gl_PointSize = max(size, 2.0);
    float tw = 1.0 + 0.25 * sin(uTime * 1.7 + aStar.z * 6.283);
    vBright = aStar.y * tw * (size * size) / max(size * size, 4.0);
    vColor = color;
}`;
const pointFragment = /* glsl */ `
varying vec3 vColor;
varying float vBright;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor * vBright * exp(-r2 * 6.0), 1.0);
}`;

function placeMatrix(dir, dist, radius, inclDeg, paDeg) {
    const obj = new THREE.Object3D();
    obj.position.copy(dir).multiplyScalar(dist);
    obj.lookAt(0, 0, 0);
    obj.rotateZ(paDeg * DEG);
    obj.rotateX(inclDeg * DEG);
    obj.scale.setScalar(radius);
    obj.updateMatrix();
    return obj.matrix;
}

export function createGalaxies({ uniforms, noise }) {
    const random = rng(777);
    const list = NAMED.map(g => ({ ...g, dir: radec(g.ra, g.dec) }));

    // Faint background galaxies, kept away from the Milky Way (the "zone of avoidance").
    while (list.length < 48) {
        const dir = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
        if (dir.lengthSq() > 1 || dir.lengthSq() < 0.01) continue;
        dir.normalize();
        if (Math.abs(dir.dot(GALACTIC.north)) < 0.3) continue;
        const spiral = random() < 0.65;
        list.push({
            dir, dist: 1300, radius: 4 + random() * 9,
            type: spiral ? SPIRAL : ELLIPTICAL,
            arms: random() < 0.7 ? 2 : 3, wind: 1.6 + random() * 1.8,
            axis: 0.5 + random() * 0.5,
            incl: random() * 80, pa: random() * 180,
            bright: 0.35 + random() * 0.4,
            core: random() < 0.5 ? Y : [1.0, 0.9, 0.78],
            arm: random() < 0.7 ? W : [0.85, 0.85, 1.0],
        });
    }

    const count = list.length;
    const geometry = new THREE.PlaneGeometry(2, 2);
    const params = new Float32Array(count * 4);
    const core = new Float32Array(count * 3);
    const arm = new Float32Array(count * 3);
    const material = new THREE.ShaderMaterial({
        vertexShader, fragmentShader,
        uniforms: { ...uniforms, uNoise: { value: noise }, uFadeNear: { value: 120 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;

    let heroMatrix = null;
    list.forEach((g, i) => {
        const matrix = placeMatrix(g.dir, g.dist, g.radius, g.incl ?? 0, g.pa ?? 0);
        if (g.hero) heroMatrix = matrix;
        mesh.setMatrixAt(i, matrix);
        params.set([g.type, g.type === SPIRAL ? g.arms : g.axis, g.wind ?? 0, (i * 0.137) % 1 * 10], i * 4);
        core.set(g.core.map(v => v * g.bright), i * 3);
        arm.set((g.arm || g.core).map(v => v * g.bright), i * 3);
    });
    geometry.setAttribute("aParams", new THREE.InstancedBufferAttribute(params, 4));
    geometry.setAttribute("aCore", new THREE.InstancedBufferAttribute(core, 3));
    geometry.setAttribute("aArm", new THREE.InstancedBufferAttribute(arm, 3));

    // Sparkle points for the hero spiral, laid along the same logarithmic arms.
    const hero = list.find(g => g.hero);
    const total = 9000;
    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const stars = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
        const r = Math.min(0.85, 0.08 + Math.pow(random(), 1.1) * 0.8);
        const armIndex = Math.floor(random() * hero.arms);
        const th = (armIndex / hero.arms) * Math.PI * 2 + hero.wind * Math.log(r) + (random() - 0.5) * 0.45;
        const scatter = (random() - 0.5) * 0.02;
        positions.set([Math.cos(th) * r + scatter, Math.sin(th) * r + scatter, (random() - 0.5) * 0.02], i * 3);
        const pick = random();
        const c = pick < 0.12 ? [1.0, 0.35, 0.55] : pick < 0.7 ? [0.7, 0.8, 1.0] : [1.0, 0.92, 0.8];
        colors.set(c, i * 3);
        stars.set([0.8 + Math.pow(random(), 6) * 2.4, 0.12 + Math.pow(random(), 5) * 1.2, random(), 0], i * 4);
    }
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    pointGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pointGeometry.setAttribute("aStar", new THREE.BufferAttribute(stars, 4));
    const heroPoints = new THREE.Points(pointGeometry, new THREE.ShaderMaterial({
        vertexShader: pointVertex, fragmentShader: pointFragment,
        uniforms: { ...uniforms },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    heroPoints.matrixAutoUpdate = false;
    heroPoints.matrix.copy(heroMatrix);
    heroPoints.frustumCulled = false;
    heroPoints.renderOrder = 2;

    const group = new THREE.Group();
    group.add(mesh, heroPoints);

    const spin = new THREE.Matrix4();
    return {
        group,
        setTier(tier) { pointGeometry.setDrawRange(0, Math.floor(total * tier.galaxyPoints)); },
        update(time) {
            // Turn the sparkle points at the same rate as the hero's shader arms (instance 0, seed 0).
            heroPoints.matrix.copy(heroMatrix).multiply(spin.makeRotationZ(time * 0.004));
            heroPoints.matrixWorldNeedsUpdate = true;
        },
    };
}
