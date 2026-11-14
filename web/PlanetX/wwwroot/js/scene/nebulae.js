import * as THREE from "./three.js";
import { DEG, radec, rng } from "./util.js";

// "Volumetric-looking" nebulae: each cloud is a stack of soft, noise-shaped layers spread in
// depth. When the camera drifts, the layers slide against each other and the cloud reads
// as a 3D volume, at the cost of a few texture fetches per pixel.

const CLOUDS = [
    // Eagle-like pillar cloud next to the opening shot (real Eagle Nebula is at 274.7, -13.8).
    { ra: 276, dec: -12, dist: 420, radius: 9, a: [1.0, 0.18, 0.4], b: [0.15, 0.75, 0.85], rim: [1.0, 0.75, 0.45], intensity: 1.0, seed: 1 },
    // Wide blue reflection veil above the hero galaxy, for depth in the opening shot.
    { ra: 248, dec: 20, dist: 520, radius: 15, a: [0.25, 0.45, 1.0], b: [0.55, 0.3, 0.95], rim: [0.7, 0.85, 1.0], intensity: 0.3, seed: 2 },
    { ra: 83.8, dec: -5.4, dist: 450, radius: 12, a: [1.0, 0.22, 0.32], b: [0.3, 0.55, 1.0], rim: [1.0, 0.8, 0.7], intensity: 0.9, seed: 3 },   // Orion
    { ra: 161, dec: -59.9, dist: 450, radius: 10, a: [1.0, 0.42, 0.2], b: [0.15, 0.8, 0.85], rim: [1.0, 0.9, 0.6], intensity: 0.9, seed: 4 },   // Carina
    { ra: 314.7, dec: 44.5, dist: 500, radius: 9, a: [1.0, 0.22, 0.28], b: [0.85, 0.45, 0.25], rim: [1.0, 0.7, 0.5], intensity: 0.7, seed: 5 }, // Cygnus
];
const MAX_LAYERS = 8;

const vertexShader = /* glsl */ `
uniform float uFadeNear;
varying vec2 vUv;
varying float vFade;
void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 centre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vFade = smoothstep(uFadeNear * 0.3, uFadeNear, distance(centre, cameraPosition));
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime, uSeed, uIntensity;
uniform vec3 uColA, uColB, uRim;
varying vec2 vUv;
varying float vFade;
void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0 || vFade <= 0.0) discard;
    vec2 q = p * 0.38 + vec2(uSeed * 0.37, uSeed * 0.71);
    float t = uTime * 0.0015;
    vec2 warp = vec2(texture2D(uNoise, q * 0.6 + t).r, texture2D(uNoise, q * 0.6 + 0.43 - t).a) - 0.5;
    float n = texture2D(uNoise, q + warp * 0.9).r;
    vec4 detail = texture2D(uNoise, q * 1.5 + warp * 1.2);
    float shape = smoothstep(1.0, 0.1, r + (n - 0.5) * 1.1);
    float density = shape * pow(clamp(n * 1.5 - 0.3, 0.0, 1.0), 2.2) * (0.5 + 0.9 * detail.g);
    float filament = detail.b * detail.b * shape * smoothstep(0.2, 0.7, n);
    float dust = smoothstep(0.55, 0.85, detail.a) * shape;
    vec3 col = mix(uColA, uColB, smoothstep(0.35, 0.75, detail.r)) * density + uRim * filament * 0.55;
    col += mix(uColA, uColB, 0.35) * shape * shape * 0.08;
    col *= 1.0 - dust * 0.7;
    gl_FragColor = vec4(col * uIntensity * vFade * 0.3, 1.0);
}`;

export function createNebulae({ uniforms, noise }) {
    const group = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const clouds = CLOUDS.map(cloud => {
        const random = rng(900 + cloud.seed);
        const centre = radec(cloud.ra, cloud.dec).multiplyScalar(cloud.dist);
        const size = cloud.dist * Math.tan(cloud.radius * DEG);
        const forward = centre.clone().normalize();
        const right = new THREE.Vector3(0, 1, 0).cross(forward).normalize();
        const up = forward.clone().cross(right);
        const layers = [];
        for (let i = 0; i < MAX_LAYERS; i++) {
            const material = new THREE.ShaderMaterial({
                vertexShader, fragmentShader,
                uniforms: {
                    ...uniforms,
                    uNoise: { value: noise },
                    uSeed: { value: cloud.seed * 3.1 + i * 1.37 },
                    uIntensity: { value: cloud.intensity },
                    uColA: { value: new THREE.Vector3(...cloud.a) },
                    uColB: { value: new THREE.Vector3(...cloud.b) },
                    uRim: { value: new THREE.Vector3(...cloud.rim) },
                    uFadeNear: { value: 90 },
                },
                transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geometry, material);
            const depth = (i / (MAX_LAYERS - 1) - 0.5) * size * 0.9;
            mesh.position.copy(centre)
                .addScaledVector(forward, depth)
                .addScaledVector(right, (random() - 0.5) * size * 0.5)
                .addScaledVector(up, (random() - 0.5) * size * 0.4);
            mesh.lookAt(0, 0, 0);
            mesh.rotateZ(random() * Math.PI * 2);
            mesh.scale.set(size * (0.65 + random() * 0.5), size * (0.5 + random() * 0.45), 1);
            mesh.renderOrder = 3;
            mesh.frustumCulled = true;
            group.add(mesh);
            layers.push(mesh);
        }
        return layers;
    });

    return {
        group,
        setTier(tier) {
            // Lower tiers keep fewer layers per cloud and brighten them to keep the same look.
            const keep = tier.nebulaLayers;
            const gain = MAX_LAYERS / keep;
            clouds.forEach((layers, c) => layers.forEach((mesh, i) => {
                mesh.visible = i % Math.round(gain) === 0 && i / Math.round(gain) < keep;
                mesh.material.uniforms.uIntensity.value = CLOUDS[c].intensity * Math.round(gain);
            }));
        },
    };
}
