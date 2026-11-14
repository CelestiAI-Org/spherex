import * as THREE from "./three.js";
import { rng } from "./util.js";

// Hyperspace streaks for the warm zoom. Lines live in camera space (children of the camera)
// in a long tube around the view axis; the vertex shader slides them toward the viewer and
// stretches them with speed, so the CPU does nothing per frame.

const vertexShader = /* glsl */ `
attribute vec4 aLine;      // x, y: offset from axis, z: start depth, w: speed factor
attribute float aEnd;      // 0 = head, 1 = tail
attribute vec3 color;
uniform float uTravel, uSpeed, uDepth;
varying vec3 vColor;
varying float vFade;
void main() {
    float z = -mod(aLine.z - uTravel * aLine.w, uDepth) - 2.0;
    float len = uSpeed * (8.0 + 70.0 * aLine.w);
    float zz = z - aEnd * len;
    vec3 p = vec3(aLine.xy, zz);
    gl_Position = projectionMatrix * vec4(p, 1.0);
    float depthFade = smoothstep(uDepth, uDepth * 0.6, -z) * smoothstep(2.0, 12.0, -z);
    vFade = depthFade * mix(1.0, 0.15, aEnd) * smoothstep(0.02, 0.35, uSpeed);
    vColor = color;
}`;
const fragmentShader = /* glsl */ `
uniform float uIntensity;
varying vec3 vColor;
varying float vFade;
void main() { gl_FragColor = vec4(vColor * vFade * uIntensity, 1.0); }`;

export function createWarpStreaks(count = 1400) {
    const random = rng(99);
    const DEPTH = 420;
    const lines = new Float32Array(count * 2 * 4);
    const ends = new Float32Array(count * 2);
    const colors = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
        const angle = random() * Math.PI * 2;
        const radius = 3 + Math.pow(random(), 0.7) * 45;
        const data = [Math.cos(angle) * radius, Math.sin(angle) * radius, random() * DEPTH, 0.4 + random() * 0.9];
        const pick = random();
        const c = pick < 0.5 ? [1.0, 0.82, 0.55] : pick < 0.8 ? [1.0, 0.95, 0.88] : [0.6, 0.75, 1.0];
        for (let e = 0; e < 2; e++) {
            lines.set(data, (i * 2 + e) * 4);
            ends[i * 2 + e] = e;
            colors.set(c, (i * 2 + e) * 3);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
    geometry.setAttribute("aLine", new THREE.BufferAttribute(lines, 4));
    geometry.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const uniforms = {
        uTravel: { value: 0 }, uSpeed: { value: 0 }, uDepth: { value: DEPTH }, uIntensity: { value: 2.2 },
    };
    const lines3 = new THREE.LineSegments(geometry, new THREE.ShaderMaterial({
        vertexShader, fragmentShader, uniforms,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    lines3.frustumCulled = false;
    lines3.renderOrder = 9;
    lines3.visible = false;
    return {
        object: lines3,
        update(dt, speed) {
            uniforms.uSpeed.value = speed;
            uniforms.uTravel.value += dt * (40 + 520 * speed * speed);
            lines3.visible = speed > 0.01;
        },
    };
}

// Target beacons: a glowing point with a slowly pulsing ring, placed at a sky position.
// The flight's own target uses one too, so it grows as the camera approaches it.
const beaconVertex = /* glsl */ `
attribute vec4 aBeacon;       // size (px at 1080p), intensity, highlight, phase
uniform float uPxScale, uTime;
varying vec3 vColor;
varying vec2 vB;
void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float grow = clamp(900.0 / -mv.z, 0.6, 6.0);
    gl_PointSize = min(aBeacon.x * uPxScale * grow * (1.0 + aBeacon.z * 2.2), 200.0);
    vColor = mix(vec3(0.55, 0.85, 1.0), vec3(1.0, 0.82, 0.5), aBeacon.z);
    vB = vec2(aBeacon.y, aBeacon.w + uTime);
}`;
const beaconFragment = /* glsl */ `
varying vec3 vColor;
varying vec2 vB;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;
    float pulse = fract(vB.y * 0.35);
    float ring = exp(-pow((r - 0.55) / 0.035, 2.0)) * 0.6;
    float wave = exp(-pow((r - pulse) / 0.04, 2.0)) * (1.0 - pulse) * 0.8;
    float core = exp(-r * r * 90.0) * 3.0 + exp(-r * r * 14.0) * 0.4;
    gl_FragColor = vec4(vColor * (ring + wave + core) * vB.x, 1.0);
}`;

export function createBeacons(uniforms, max = 8) {
    const positions = new Float32Array(max * 3);
    const data = new Float32Array(max * 4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aBeacon", new THREE.BufferAttribute(data, 4));
    geometry.setDrawRange(0, 0);
    const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
        vertexShader: beaconVertex, fragmentShader: beaconFragment, uniforms: { ...uniforms },
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    points.frustumCulled = false;
    points.renderOrder = 8;
    return {
        object: points,
        set(list) {
            list.slice(0, max).forEach((b, i) => {
                positions.set([b.position.x, b.position.y, b.position.z], i * 3);
                data.set([b.size ?? 34, b.intensity ?? 1, b.highlight ?? 0, i * 0.37], i * 4);
            });
            geometry.setDrawRange(0, Math.min(list.length, max));
            geometry.attributes.position.needsUpdate = true;
            geometry.attributes.aBeacon.needsUpdate = true;
        },
    };
}
