import * as THREE from "./three.js";
import { DEG, gaussian, rng } from "./util.js";

// Slow debris belt (instanced, flat-shaded rocks lit warm from the black hole's side and
// cool from behind) and a field of drifting dust that wraps around the camera.

function noise3Factory(seed) {
    const random = rng(seed);
    const table = new Float32Array(512);
    for (let i = 0; i < table.length; i++) table[i] = random();
    const hash = (x, y, z) => table[((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 511];
    const fade = t => t * t * (3 - 2 * t);
    return (x, y, z) => {
        const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
        const lerp = (a, b, t) => a + (b - a) * t;
        const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
        return lerp(
            lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf),
            lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf),
            zf,
        );
    };
}

function rockGeometry(seed, stretch) {
    const geometry = new THREE.IcosahedronGeometry(1, 3);
    const noise = noise3Factory(seed);
    const p = geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).normalize();
        const n = noise(v.x * 1.6 + 10, v.y * 1.6 + 10, v.z * 1.6 + 10) * 0.55
            + noise(v.x * 4 + 3, v.y * 4 + 3, v.z * 4 + 3) * 0.18
            + noise(v.x * 9 + 7, v.y * 9 + 7, v.z * 9 + 7) * 0.06;
        v.multiplyScalar(0.62 + n).multiply(stretch);
        p.setXYZ(i, v.x, v.y, v.z);
    }
    geometry.computeVertexNormals();
    return geometry;
}

const dustVertex = /* glsl */ `
attribute vec4 aDust;          // xyz: start position in the wrap box, w: brightness
uniform float uTime, uPxScale, uBox, uWarp;
uniform vec3 uDrift;
varying float vAlpha;
varying vec3 vColor;
void main() {
    vec3 p = mod(aDust.xyz + uDrift * uTime - cameraPosition, uBox) - uBox * 0.5;
    vec4 mv = viewMatrix * vec4(cameraPosition + p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    float size = clamp(30.0 / max(dist, 0.5), 1.0, 9.0) * uPxScale * (1.0 + uWarp * 1.5);
    gl_PointSize = size;
    float edge = 1.0 - smoothstep(uBox * 0.3, uBox * 0.5, length(p));
    float near = smoothstep(0.6, 2.5, dist);
    vAlpha = aDust.w * edge * near * (0.35 + uWarp * 2.5);
    vColor = mix(vec3(1.0, 0.78, 0.55), vec3(0.6, 0.75, 1.0), fract(aDust.w * 13.7));
}`;
const dustFragment = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColor * vAlpha * exp(-r2 * 3.0), 1.0);
}`;

export function createDebris({ uniforms, lightDir, home }) {
    const group = new THREE.Group();
    const random = rng(4242);

    // Lighting just for the rocks: warm key from the accretion disk, cool rim, dim fill.
    const key = new THREE.DirectionalLight(new THREE.Color(1.0, 0.72, 0.45), 6.0);
    key.position.copy(lightDir).multiplyScalar(100);
    const rim = new THREE.DirectionalLight(new THREE.Color(0.55, 0.68, 1.0), 0.9);
    rim.position.copy(lightDir).multiplyScalar(-100).add(new THREE.Vector3(0, 40, 0));
    const fill = new THREE.AmbientLight(new THREE.Color(0.35, 0.4, 0.55), 0.05);
    group.add(key, rim, fill);

    // Belt plane: passes about 14 degrees below the opening view, running across the screen.
    const f = home.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(f, -f.y).normalize();
    const right = new THREE.Vector3().crossVectors(f, up).normalize();
    const through = f.clone().multiplyScalar(Math.cos(14 * DEG)).addScaledVector(up, -Math.sin(14 * DEG));
    const normal = new THREE.Vector3().crossVectors(right, through).normalize();
    const axisA = through.clone();
    const axisB = new THREE.Vector3().crossVectors(normal, axisA).normalize();

    const material = new THREE.MeshStandardMaterial({ color: 0x4a423b, roughness: 0.95, metalness: 0.05, flatShading: true });
    const shapes = [
        rockGeometry(1, new THREE.Vector3(1.3, 0.85, 0.9)),
        rockGeometry(2, new THREE.Vector3(1.0, 1.0, 0.7)),
        rockGeometry(3, new THREE.Vector3(1.6, 0.7, 0.8)),
    ];
    const MAX = 240;
    const rocks = [];
    const meshes = shapes.map(geometry => {
        const mesh = new THREE.InstancedMesh(geometry, material, MAX / shapes.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.renderOrder = 5;
        group.add(mesh);
        return mesh;
    });
    for (let i = 0; i < MAX; i++) {
        const big = Math.pow(random(), 4);
        rocks.push({
            mesh: meshes[i % meshes.length],
            index: Math.floor(i / meshes.length),
            radius: 90 + random() * 150,
            angle: random() * Math.PI * 2,
            height: gaussian(random) * 9,
            speed: (0.003 + random() * 0.006) * (random() < 0.5 ? 1 : -1) * 0.5,
            scale: 0.3 + big * 3.0,
            axis: new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize(),
            spin: (random() - 0.5) * 0.5,
            phase: random() * 6.28,
        });
    }
    const dummy = new THREE.Object3D();

    // Dust in a box that wraps around the camera.
    const DUST = 3500;
    const dust = new Float32Array(DUST * 4);
    const BOX = 70;
    for (let i = 0; i < DUST; i++) {
        dust.set([random() * BOX, random() * BOX, random() * BOX, 0.04 + Math.pow(random(), 3) * 0.35], i * 4);
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST * 3), 3));
    dustGeometry.setAttribute("aDust", new THREE.BufferAttribute(dust, 4));
    const dustUniforms = {
        uBox: { value: BOX },
        uWarp: { value: 0 },
        uDrift: { value: new THREE.Vector3(0.35, 0.08, -0.2) },
    };
    const dustPoints = new THREE.Points(dustGeometry, new THREE.ShaderMaterial({
        vertexShader: dustVertex, fragmentShader: dustFragment,
        uniforms: { ...uniforms, ...dustUniforms },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    dustPoints.frustumCulled = false;
    dustPoints.renderOrder = 6;
    group.add(dustPoints);

    let activeRocks = MAX;
    return {
        group,
        setTier(tier) {
            activeRocks = Math.min(MAX, tier.asteroids);
            meshes.forEach(mesh => { mesh.count = Math.ceil(activeRocks / meshes.length); });
            dustGeometry.setDrawRange(0, Math.floor(DUST * tier.dust));
        },
        update(time, warp) {
            dustUniforms.uWarp.value = warp;
            for (const r of rocks) {
                if (r.index >= r.mesh.count) continue;
                const a = r.angle + time * r.speed;
                dummy.position.copy(axisA).multiplyScalar(Math.cos(a) * r.radius)
                    .addScaledVector(axisB, Math.sin(a) * r.radius)
                    .addScaledVector(normal, r.height + Math.sin(time * 0.05 + r.phase) * 0.8);
                dummy.quaternion.setFromAxisAngle(r.axis, r.phase + time * r.spin);
                dummy.scale.setScalar(r.scale);
                dummy.updateMatrix();
                r.mesh.setMatrixAt(r.index, dummy.matrix);
            }
            meshes.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
        },
    };
}
