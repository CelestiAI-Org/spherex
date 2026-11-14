import * as THREE from "./three.js";
import { HASH } from "./glsl.js";
import { DEG, radec } from "./util.js";

// A distant supermassive black hole with gravitational lensing, written for WebGL2.
//
// A camera-facing quad covers the region where lensing is visible. For each pixel the view
// ray is moved into the black hole's frame (units of the Schwarzschild radius r_s = 1):
//  - Far from the hole (impact parameter b > R) the bending is small, so it is applied
//    analytically with the weak-field result (total deflection 2 r_s / b).
//  - Inside a sphere of radius R the ray is integrated with the exact Schwarzschild photon
//    orbit equation  x'' = -1.5 h^2 x / r^5  (velocity Verlet, step size proportional to r).
//    The weak-field bending outside the sphere is added before and after, so the two
//    regions join without a seam.
// The thin accretion disk lies in the hole's local XZ plane. Each time the ray crosses it,
// disk emission is composited front to back, so the far side of the disk appears lensed
// over the top and under the shadow, and repeated near-orbits build the photon ring.
// Escaping rays sample the same sky cubemap as the background, so the real sky is lensed.

const R_SPHERE = 22;      // integration sphere radius (r_s)
const QUAD_HALF = 50;     // half-size of the lensing quad (r_s); bending fades out at its edge
const DIST_RS = 55;      // camera distance in r_s; sets the apparent size

const vertexShader = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;
void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

const fragmentShader = /* glsl */ `
#define MAX_STEPS 160
uniform samplerCube uSky;
uniform sampler2D uNoise;
uniform vec3 uBhPos;
uniform mat3 uBasis;          // local -> world (columns: disk x, disk normal, disk z)
uniform float uScale;         // world units per r_s
uniform float uTime, uDPhi, uPixelAngle, uDiskGain, uBeaming, uIntensity;
uniform int uSteps;
varying vec3 vWorld;
varying vec2 vUv;
${HASH}

const float R = ${R_SPHERE.toFixed(1)};
const float DISK_IN = 2.6;
const float DISK_OUT = 15.0;

// Weak-field deflection accumulated while travelling from s0 to s1 along a straight line
// with impact parameter b (s measured from the point of closest approach).
float weakBend(float b, float s0, float s1) {
    float t1 = s1 > 1e6 ? 1.0 : s1 / sqrt(s1 * s1 + b * b);
    return (t1 - s0 / sqrt(s0 * s0 + b * b)) / b;
}
vec3 bendToward(vec3 v, vec3 closest, float b, float alpha) {
    return normalize(v - (closest / max(b, 1e-4)) * alpha);
}

vec3 palette(float t) {
    vec3 red = vec3(0.9, 0.14, 0.03), orange = vec3(1.0, 0.46, 0.1), gold = vec3(1.0, 0.78, 0.46), white = vec3(1.0, 0.96, 0.9);
    t = clamp(t, 0.0, 1.0);
    return t < 0.33 ? mix(red, orange, t / 0.33) : t < 0.66 ? mix(orange, gold, (t - 0.33) / 0.33) : mix(gold, white, (t - 0.66) / 0.34);
}

// Disk emission at a crossing point; v is the traced ray direction (camera -> disk).
vec4 disk(vec3 hit, vec3 v) {
    float r = length(hit.xz);
    float phi = atan(hit.z, hit.x);
    float x = (r - DISK_IN) / (DISK_OUT - DISK_IN);
    // Thin-disk temperature profile, zero at the inner edge and peaking just outside it.
    float temp = pow(DISK_IN / r, 0.75) * pow(max(1.0 - sqrt(DISK_IN / r) * 0.95, 0.0), 0.25) * 2.4;

    // Turbulence carried round at the local Keplerian rate, with a two-phase cycle so the
    // differential rotation never winds the pattern up into stripes.
    float omega = 0.9 * pow(r, -1.5);
    float cycle = uTime / 7.0;
    float p1 = fract(cycle), p2 = fract(cycle + 0.5);
    float u = phi / 6.2831853 * 3.0;
    float lr = log(r) * 2.2;
    float nA = texture2D(uNoise, vec2(u - omega * p1 * 7.0 * 0.4775, lr)).r;
    float nB = texture2D(uNoise, vec2(u - omega * p2 * 7.0 * 0.4775 + 0.37, lr + 0.21)).r;
    float n = mix(nB, nA, 1.0 - abs(1.0 - 2.0 * p1));
    float fine = texture2D(uNoise, vec2(u * 2.0 - uTime * omega * 0.08, lr * 3.1)).b;
    float density = smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.35, 1.0, x)) * (0.3 + 1.1 * n * n) * (0.75 + 0.5 * fine);

    // Relativistic Doppler beaming and gravitational redshift.
    float beta = min(sqrt(0.5 / max(r - 1.0, 0.3)), 0.75);
    vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
    float cosTheta = dot(orbit, -normalize(v));
    float gamma = 1.0 / sqrt(1.0 - beta * beta);
    float g = sqrt(max(1.0 - 1.0 / r, 0.0)) / (gamma * (1.0 - beta * cosTheta));
    float boost = mix(1.0, clamp(pow(g, 3.0), 0.08, 8.0), uBeaming);

    vec3 color = palette(temp * mix(1.0, g, 0.5) * 0.78) * temp * temp * boost * uDiskGain;
    float alpha = clamp(density * 1.3, 0.0, 0.96);
    return vec4(color * density, alpha);
}

// Crisp point stars evaluated per pixel from the final ray direction, so lensed stars
// stretch into arcs near the Einstein ring.
vec3 crispStars(vec3 d) {
    float scale = 360.0;
    vec3 p = d * scale;
    vec3 c = floor(p);
    vec3 h = hash33(c);
    if (h.x > 0.22) return vec3(0.0);
    vec3 sp = c + 0.25 + h.yzx * 0.5;
    float radius = max(uPixelAngle * scale * 0.8, 0.02);
    float dist = length(p - sp);
    float m = 0.08 + pow(hash13(c + 3.1), 12.0) * 4.0;
    float t = hash13(c + 9.7);
    vec3 col = t < 0.3 ? vec3(1.0, 0.75, 0.55) : t < 0.7 ? vec3(1.0, 0.95, 0.88) : vec3(0.75, 0.83, 1.0);
    return col * m * exp(-dist * dist / (radius * radius));
}

// Mip level for the sky lookup. Near seams the final direction jumps between neighbouring
// pixels; clamping keeps the GPU from picking a very blurry mip there (which drew a dashed line).
float skyLod(vec3 d, vec3 camRay) {
    float texel = 1.5707963 / float(textureSize(uSky, 0).x);
    float lodFinal = log2(max(length(fwidth(d)), 1e-6) / texel);
    float lodRay = log2(max(length(fwidth(camRay)), 1e-6) / texel);
    return clamp(min(lodFinal, lodRay + 1.5), 0.0, 6.0);
}

void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float rq = length(q);
    if (rq > 1.0) discard;
    float edge = 1.0 - smoothstep(0.55, 1.0, rq);      // lensing strength fades to zero at the rim

    mat3 toLocal = transpose(uBasis);
    vec3 ro = toLocal * (cameraPosition - uBhPos) / uScale;
    vec3 rd = normalize(toLocal * normalize(vWorld - cameraPosition));

    float sCam = dot(ro, rd);
    vec3 closest = ro - sCam * rd;
    float b = length(closest);

    vec3 col = vec3(0.0);
    float transmit = 1.0;
    vec3 skyDir = rd;
    float skyWeight = 0.0, starGain = 1.0;

    if (b >= R || sCam > 0.0) {
        // Weak field only.
        skyDir = bendToward(rd, closest, b, weakBend(b, sCam, 1e7) * edge);
        starGain = 1.0 - smoothstep(R * 0.8, R * 1.6, b);
        skyWeight = 1.0;
    } else {
        float sIn = -sqrt(R * R - b * b);
        vec3 x0 = closest + sIn * rd;
        vec3 v0 = bendToward(rd, closest, b, weakBend(b, sCam, sIn));

        // The orbit stays in the plane of x0 and v0. Integrate u = 1/r over the orbit angle
        // with RK4 on u'' = 1.5 u^2 - u (Schwarzschild, r_s = 1). Fixed angular steps mean
        // neighbouring rays are integrated identically, so there is no banding.
        vec3 e1 = normalize(x0);
        vec3 nrm = cross(x0, v0);
        nrm = length(nrm) < 1e-6 ? vec3(0.0, 1.0, 0.0) : normalize(nrm);
        vec3 e2 = cross(nrm, e1);
        float u = 1.0 / R;
        float du = -u * dot(v0, e1) / max(dot(v0, e2), 1e-4);
        float phi = 0.0;
        float h = uDPhi;
        vec3 prev = x0;
        bool captured = false, escaped = false;
        float ringGlow = 0.0;
        for (int i = 0; i < MAX_STEPS; i++) {
            if (i >= uSteps) break;
            float k1u = du, k1v = 1.5 * u * u - u;
            float ua = u + 0.5 * h * k1u, va = du + 0.5 * h * k1v;
            float k2u = va, k2v = 1.5 * ua * ua - ua;
            float ub = u + 0.5 * h * k2u, vb = du + 0.5 * h * k2v;
            float k3u = vb, k3v = 1.5 * ub * ub - ub;
            float uc = u + h * k3u, vc = du + h * k3v;
            float k4u = vc, k4v = 1.5 * uc * uc - uc;
            u += h / 6.0 * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
            du += h / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
            phi += h;
            if (u >= 1.0) { captured = true; break; }
            if (u <= 1.0 / R && du < 0.0) { escaped = true; break; }

            vec3 pos = (cos(phi) * e1 + sin(phi) * e2) / u;
            if (prev.y * pos.y < 0.0) {
                vec3 hit = mix(prev, pos, prev.y / (prev.y - pos.y));
                float rh = length(hit.xz);
                if (rh > DISK_IN && rh < DISK_OUT) {
                    vec4 e = disk(hit, normalize(pos - prev));
                    col += transmit * e.rgb;
                    transmit *= 1.0 - e.a;
                }
            }
            // Thin glow where rays skim the photon sphere (r = 1.5).
            float r = 1.0 / u;
            ringGlow += exp(-pow((r - 1.5) / 0.05, 2.0)) * h;
            prev = pos;
            if (transmit < 0.02) break;
        }
        // Rays still spiralling near the hole when the step budget runs out are absorbed.
        if (!escaped && !captured && 1.0 / max(u, 1e-4) < 2.5) captured = true;
        col += transmit * vec3(1.0, 0.8, 0.55) * ringGlow * 0.35 * uDiskGain;
        if (!captured && transmit > 0.02) {
            float ui = max(u, 1e-4);
            vec3 radial = cos(phi) * e1 + sin(phi) * e2;
            vec3 x = radial / ui;
            vec3 v = normalize((-sin(phi) * e1 + cos(phi) * e2) / ui - radial * du / (ui * ui));
            float sOut = dot(x, v);
            vec3 c2 = x - sOut * v;
            float bOut = length(c2);
            skyDir = bendToward(v, c2, bOut, weakBend(bOut, sOut, 1e7));
            skyWeight = transmit;
        }
    }

    // Sky lookup after the branches, where screen-space derivatives are well defined.
    vec3 worldSky = normalize(uBasis * skyDir);
    float lod = skyLod(worldSky, normalize(vWorld - cameraPosition));
    if (skyWeight > 0.0) col += skyWeight * (textureLod(uSky, worldSky, lod).rgb + crispStars(worldSky) * starGain);

    float alpha = 1.0 - smoothstep(0.82, 1.0, rq);
    gl_FragColor = vec4(col * uIntensity, alpha);
}`;

export function createBlackHole({ skyTexture, noise, ra = 233, dec = -26, distance = 1700 }) {
    const position = radec(ra, dec).multiplyScalar(distance);
    const scale = distance / DIST_RS;

    // Disk orientation: seen almost edge-on (camera ~9 degrees above the disk plane),
    // rolled a little for a more dynamic composition.
    const forward = position.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const up = worldUp.clone().addScaledVector(forward, -worldUp.dot(forward)).normalize();
    up.applyAxisAngle(forward, -14 * DEG);
    const elevation = 9 * DEG;
    const normal = up.clone().multiplyScalar(Math.cos(elevation)).addScaledVector(forward, -Math.sin(elevation)).normalize();
    const diskX = new THREE.Vector3().crossVectors(normal, forward).normalize();
    const diskZ = new THREE.Vector3().crossVectors(diskX, normal).normalize();
    const basis = new THREE.Matrix3().set(
        diskX.x, normal.x, diskZ.x,
        diskX.y, normal.y, diskZ.y,
        diskX.z, normal.z, diskZ.z,
    );

    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            uSky: { value: skyTexture },
            uNoise: { value: noise },
            uBhPos: { value: position },
            uBasis: { value: basis },
            uScale: { value: scale },
            uTime: { value: 0 },
            uSteps: { value: 80 },
            uDPhi: { value: 0.07 },
            uPixelAngle: { value: 0.001 },
            uDiskGain: { value: 0.85 },
            uBeaming: { value: 0.7 },
            uIntensity: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
    });
    const size = QUAD_HALF * 2 * scale;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.position.copy(position);
    mesh.renderOrder = 0;      // right after the background; stars and nebulae draw on top
    mesh.frustumCulled = true;

    return {
        mesh,
        position,
        setTier(tier) {
            material.uniforms.uSteps.value = tier.bhSteps;
            material.uniforms.uDPhi.value = THREE.MathUtils.clamp(5.6 / tier.bhSteps, 0.045, 0.12);
        },
        update(time, camera, renderHeight) {
            mesh.lookAt(camera.position);
            material.uniforms.uTime.value = time;
            material.uniforms.uPixelAngle.value = (camera.fov * DEG) / renderHeight;
        },
    };
}
