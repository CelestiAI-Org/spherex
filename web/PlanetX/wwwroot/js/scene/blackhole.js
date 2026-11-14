import * as THREE from "./three.js";
import { HASH } from "./glsl.js";
import { DEG, radec } from "./util.js";

// Supermassive black hole with gravitational lensing, written for WebGL2.
//
// The hole is ray traced in its own full-screen pass into an offscreen HDR buffer (which can run
// below screen resolution), then composited over the sky background inside the main HDR scene,
// so stars, nebulae and rocks draw on top and bloom picks up the disk.
//
// For each pixel the view ray is moved into the hole's frame (units of the Schwarzschild radius,
// r_s = 1):
//  - Far from the hole (impact parameter b > R) the bending is small and is applied analytically
//    with the weak-field result (total deflection 2 r_s / b).
//  - Inside a sphere of radius R each ray is integrated in its own orbit plane with RK4 on the
//    Schwarzschild photon-orbit equation u'' + u = 1.5 u^2 (u = 1 / r), at fixed angular steps,
//    so neighbouring rays are integrated identically and nothing bands. The weak-field bending
//    outside the sphere is stitched on before and after, so there is no seam.
// The accretion disk lies in the hole's local XZ plane. Every crossing composites disk emission
// front to back, which produces the lensed far side arching over and under the shadow, the
// secondary images and the thin photon ring. Escaping rays sample the same sky cubemap as the
// background (plus crisp per-pixel stars), so the real sky bends around the hole.

const R_SPHERE = 16;      // integration sphere radius (r_s); outside it the weak-field result is used
const B_MAX = 44;         // lensing fades out completely at this impact parameter (r_s)
const DIST_RS = 26;       // camera distance in r_s: sets the apparent size
const DISK_IN = 3.0;      // innermost stable circular orbit, 3 r_s for Schwarzschild
const DISK_OUT = 13.0;
const SPOTS = 7;          // bright clumps orbiting in the disk

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fragmentShader = /* glsl */ `
#define MAX_STEPS 160
#define MAX_OCTAVES 5
uniform samplerCube uSky;
uniform sampler2D uNoise;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uBhPos;
uniform mat3 uBasis;          // local -> world (columns: disk x, disk normal, disk z)
uniform float uScale;         // world units per r_s
uniform float uTime, uDPhi, uPixelAngle, uDiskGain, uBeaming, uSpin;
uniform int uSteps, uOctaves;
uniform vec4 uSpots[${SPOTS}];   // radius, start angle, brightness, length along the orbit
varying vec2 vUv;
${HASH}

const float R = ${R_SPHERE.toFixed(1)};
const float B_MAX = ${B_MAX.toFixed(1)};
const float DISK_IN = ${DISK_IN.toFixed(1)};
const float DISK_OUT = ${DISK_OUT.toFixed(1)};
const float TAU = 6.2831853;
const float CYCLE = 16.0;     // seconds per flow cycle of the turbulence

// Weak-field deflection accumulated while travelling from s0 to s1 along a straight line with
// impact parameter b (s measured from the point of closest approach).
float weakBend(float b, float s0, float s1) {
    float t1 = s1 > 1e6 ? 1.0 : s1 / sqrt(s1 * s1 + b * b);
    return (t1 - s0 / sqrt(s0 * s0 + b * b)) / b;
}
vec3 bendToward(vec3 v, vec3 closest, float b, float alpha) {
    return normalize(v - (closest / max(b, 1e-4)) * alpha);
}

// Observed-temperature palette: deep red -> orange -> gold -> white -> blue-white.
vec3 palette(float t) {
    t = clamp(t, 0.0, 1.6);
    vec3 c0 = vec3(0.5, 0.05, 0.01), c1 = vec3(1.0, 0.3, 0.05), c2 = vec3(1.0, 0.64, 0.28);
    vec3 c3 = vec3(1.0, 0.9, 0.78), c4 = vec3(0.6, 0.76, 1.0);
    if (t < 0.4) return mix(c0, c1, t / 0.4);
    if (t < 0.75) return mix(c1, c2, (t - 0.4) / 0.35);
    if (t < 1.05) return mix(c2, c3, (t - 0.75) / 0.3);
    return mix(c3, c4, smoothstep(1.0, 1.45, t));
}

// Thin-disk radiative flux F ~ r^-3 (1 - sqrt(r_in / r)), scaled to peak at about 1.
float diskFlux(float r) {
    float q = DISK_IN / r;
    return q * q * q * max(1.0 - sqrt(q), 0.0) * 17.7;
}

// Mip level for a noise lookup whose texture coordinates change by "perUnit" per r_s, given the
// size of one pixel on the disk. Inside the loop the GPU's automatic derivatives are unreliable
// (and the edge-on disk squashes the texture), so the level is computed explicitly.
float noiseLod(float footprint, float perUnit) {
    return log2(max(footprint * perUnit * 256.0, 1e-4));
}

// Disk emission where a ray crosses the disk plane; v is the ray direction (camera -> disk);
// footprint is the size of one pixel at the hit point (r_s), grazing the |sine| of the angle
// between the ray and the disk plane.
vec4 disk(vec3 hit, vec3 v, float footprint, float grazing) {
    float r = length(hit.xz);
    float x = (r - DISK_IN) / (DISK_OUT - DISK_IN);
    float phi = atan(hit.z, hit.x);
    float flux = diskFlux(r);
    float temp = pow(flux, 0.25);

    // Turbulence carried round at the local Keplerian rate. Two phases half a cycle apart are
    // cross-faded so differential rotation never winds the pattern into stripes. Coordinates
    // are stretched along the orbit, so features become long arcs and filaments.
    float omega = uSpin * pow(r, -1.5);
    float cycle = uTime / CYCLE;
    float p1 = fract(cycle), p2 = fract(cycle + 0.5);
    float w = 1.0 - abs(1.0 - 2.0 * p1);
    float u0 = phi / TAU * 4.0;
    float lr = log(r) * 2.6;
    float turb = 0.0, amp = 0.5, norm = 0.0, freq = 1.0;
    float radialPx = footprint / max(grazing, 0.035);     // pixel length along the radius
    for (int o = 0; o < MAX_OCTAVES; o++) {
        if (o >= uOctaves) break;
        vec2 base = vec2(u0 * freq, lr * freq + float(o) * 0.37);
        float shiftA = omega * p1 * CYCLE * 0.6366 * freq;
        float shiftB = omega * p2 * CYCLE * 0.6366 * freq;
        float lod = max(noiseLod(radialPx, 2.6 * freq / r), noiseLod(footprint, 4.0 * freq / (TAU * r)));
        float a = textureLod(uNoise, base - vec2(shiftA, 0.0), lod).r;
        float b = textureLod(uNoise, base - vec2(shiftB, 0.0) + vec2(0.5, 0.31), lod).r;
        turb += amp * mix(b, a, w);
        norm += amp;
        amp *= 0.55;
        freq *= 2.03;
    }
    turb /= norm;
    // Fine filaments from the ridged channel, sampled a mip softer so they never alias into dots.
    float filLod = max(noiseLod(radialPx, 3.0 / r), noiseLod(footprint, 8.0 / (TAU * r))) + 0.5;
    float fil = textureLod(uNoise, vec2(u0 * 2.0 - uTime * omega * 0.08, lr * 3.0), filLod).b;
    fil = smoothstep(0.45, 0.95, fil);

    float edgeIn = smoothstep(0.0, 0.025, x);
    float edgeOut = 1.0 - smoothstep(0.45, 1.0, x);
    float density = edgeIn * edgeOut * (0.3 + 1.05 * turb * turb + 0.5 * fil);

    // Hot spots: compact clumps of gas, each orbiting at its own Keplerian rate, so light is
    // visibly carried round the hole (and, through the lensing, over the top of it).
    float spots = 0.0;
    for (int i = 0; i < ${SPOTS}; i++) {
        vec4 sp = uSpots[i];
        float angle = sp.y + uSpin * pow(sp.x, -1.5) * uTime;
        float dphi = mod(phi - angle + 3.14159265, TAU) - 3.14159265;
        float along = dphi * sp.x;                       // distance along the orbit (r_s)
        float trail = along < 0.0 ? sp.w * 2.2 : sp.w;   // a longer tail behind the clump
        float d2 = (along * along) / (trail * trail) + pow((r - sp.x) / 0.32, 2.0);
        spots += sp.z * exp(-d2);
    }
    density += spots * 0.6 * edgeIn;
    float rim = exp(-pow((r - DISK_IN) / 0.25, 2.0)) * edgeIn;    // hot inner edge

    // Special-relativistic Doppler shift of orbiting gas plus gravitational redshift.
    float beta = min(sqrt(0.5 / max(r - 1.0, 0.3)), 0.75);
    vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
    float cosTheta = dot(orbit, -normalize(v));
    float gamma = 1.0 / sqrt(1.0 - beta * beta);
    float g = sqrt(max(1.0 - 1.0 / r, 0.0)) / (gamma * (1.0 - beta * cosTheta));
    float beam = mix(1.0, clamp(pow(g, 3.0), 0.05, 7.0), uBeaming);

    vec3 color = palette(temp * mix(1.0, g, 0.9) * 1.05);
    vec3 emission = (color * (flux * density * 3.0 + rim * 1.6) + palette(temp * g * 1.25) * spots * 2.2) * beam * uDiskGain;
    float alpha = clamp(density * 1.15 + rim * 0.5, 0.0, 0.96);
    return vec4(emission, alpha);
}

float erfApprox(float x) {
    float x2 = x * x;
    float a = 0.147;
    return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + a * x2) / (1.0 + a * x2)));
}

// Soft glow in a thin Gaussian sheet above and below the disk. Integrated exactly over each
// straight step (erf of the heights), so it is smooth however coarse the steps are.
float haze(vec3 p0, vec3 p1) {
    vec3 m = 0.5 * (p0 + p1);
    float r = length(m.xz);
    if (r < DISK_IN || r > DISK_OUT) return 0.0;
    float h = 0.045 * r;
    // Cheap exit for steps that stay well clear of the glow sheet.
    if (p0.y * p1.y > 0.0 && min(abs(p0.y), abs(p1.y)) > 3.0 * h) return 0.0;
    float seg = length(p1 - p0);
    float dy = p1.y - p0.y;
    float path = abs(dy) > 1e-3 * seg
        ? seg / abs(dy) * h * 0.8862269 * abs(erfApprox(p1.y / h) - erfApprox(p0.y / h))
        : seg * exp(-(m.y * m.y) / (h * h));
    return diskFlux(r) * min(path, 4.0 * h);
}

// Crisp point stars evaluated per pixel from the final ray direction, so lensed stars stretch
// into arcs around the Einstein ring.
vec3 crispStars(vec3 d) {
    float scale = 340.0;
    vec3 p = d * scale;
    vec3 c = floor(p);
    vec3 h = hash33(c);
    if (h.x > 0.16) return vec3(0.0);
    vec3 sp = c + 0.25 + h.yzx * 0.5;
    float radius = max(uPixelAngle * scale * 0.7, 0.015);
    float dist = length(p - sp);
    float m = 0.1 + pow(hash13(c + 3.1), 12.0) * 5.0;
    float t = hash13(c + 9.7);
    vec3 col = t < 0.3 ? vec3(1.0, 0.75, 0.55) : t < 0.7 ? vec3(1.0, 0.95, 0.88) : vec3(0.75, 0.83, 1.0);
    return col * m * exp(-dist * dist / (radius * radius));
}

void main() {
    vec4 viewRay = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 rdWorld = normalize(mat3(uCamWorld) * normalize(viewRay.xyz / viewRay.w));

    mat3 toLocal = transpose(uBasis);
    vec3 ro = toLocal * (uCamPos - uBhPos) / uScale;
    vec3 rd = normalize(toLocal * rdWorld);

    float sCam = dot(ro, rd);
    vec3 closest = ro - sCam * rd;
    float b = length(closest);
    bool inside = dot(ro, ro) < R * R;

    // Early pixel exit: rays that pass far from the hole, or point away from it, are untouched.
    if (!inside && (b > B_MAX || sCam > 0.0)) {
        gl_FragColor = vec4(0.0);
        return;
    }
    float rq = b / B_MAX;
    float lensFade = 1.0 - smoothstep(0.5, 1.0, rq);

    vec3 col = vec3(0.0);
    float transmit = 1.0;
    vec3 skyDir = rd;
    float skyWeight = 0.0, starGain = 1.0;

    if (!inside && b >= R) {
        skyDir = bendToward(rd, closest, b, weakBend(b, sCam, 1e7) * lensFade);
        starGain = 1.0 - smoothstep(R * 0.8, R * 1.6, b);
        skyWeight = 1.0;
    } else {
        vec3 x0, v0;
        if (inside) {
            x0 = ro;
            v0 = rd;
        } else {
            float sIn = -sqrt(R * R - b * b);
            x0 = closest + sIn * rd;
            v0 = bendToward(rd, closest, b, weakBend(b, sCam, sIn));
        }

        // Orbit-plane basis; integrate u = 1/r over the orbit angle with RK4.
        vec3 e1 = normalize(x0);
        vec3 nrm = cross(x0, v0);
        nrm = length(nrm) < 1e-6 ? vec3(0.0, 1.0, 0.0) : normalize(nrm);
        vec3 e2 = cross(nrm, e1);
        float u = 1.0 / length(x0);
        float du = -u * dot(v0, e1) / max(dot(v0, e2), 1e-4);
        float h = uDPhi;
        float cd = cos(h), sd = sin(h);
        float c = 1.0, s = 0.0;          // cos and sin of the orbit angle, advanced by rotation
        vec3 prev = x0;
        float travelled = length(x0 - ro);
        bool captured = false, escaped = false;
        float ringGlow = 0.0, glow = 0.0;
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
            float cn = c * cd - s * sd;
            s = s * cd + c * sd;
            c = cn;

            // Early ray exits: fell through the horizon, or left the sphere for good.
            if (u >= 1.0) { captured = true; break; }
            if (u <= 1.0 / R && du < 0.0) { escaped = true; break; }

            vec3 pos = (c * e1 + s * e2) / u;
            float seg = length(pos - prev);
            if (prev.y * pos.y < 0.0) {
                float f = prev.y / (prev.y - pos.y);
                vec3 hit = mix(prev, pos, f);
                float rh = length(hit.xz);
                if (rh > DISK_IN * 0.97 && rh < DISK_OUT) {
                    vec3 dir = (pos - prev) / max(seg, 1e-5);
                    vec4 e = disk(hit, dir, uPixelAngle * (travelled + seg * f), abs(dir.y));
                    col += transmit * e.rgb * e.a;
                    transmit *= 1.0 - e.a;
                }
            }
            if (u < 0.5) glow += transmit * haze(prev, pos);
            travelled += seg;
            ringGlow += transmit * exp(-pow((1.0 / u - 1.5) / 0.04, 2.0)) * h;
            prev = pos;
            // Early exit once the disk has made the ray effectively opaque.
            if (transmit < 0.02) break;
        }
        // Rays still circling close to the hole when the step budget runs out are absorbed.
        if (!escaped && !captured && 1.0 / max(u, 1e-4) < 2.5) captured = true;
        col += vec3(1.0, 0.78, 0.5) * glow * 0.025 * uDiskGain;
        // The photon-ring glow belongs to rays that skim the photon sphere and get away.
        if (!captured) col += vec3(1.0, 0.86, 0.68) * ringGlow * 0.4 * uDiskGain;
        if (!captured && transmit > 0.02) {
            float ui = max(u, 1e-4);
            vec3 radial = c * e1 + s * e2;
            vec3 x = radial / ui;
            vec3 v = normalize((-s * e1 + c * e2) / ui - radial * du / (ui * ui));
            float sOut = dot(x, v);
            vec3 c2 = x - sOut * v;
            float bOut = length(c2);
            skyDir = bendToward(v, c2, bOut, weakBend(bOut, sOut, 1e7));
            skyWeight = transmit;
            // Stars seen through the gas would be smeared into dashes by the lensing: hide them.
            starGain = smoothstep(0.75, 0.98, transmit);
        }
    }

    // Sky lookup after the branches, where screen-space derivatives are defined. The LOD is
    // clamped so rays that diverge sharply (near the shadow) don't pick a very blurry mip.
    vec3 worldSky = normalize(uBasis * skyDir);
    float texel = 1.5707963 / float(textureSize(uSky, 0).x);
    float lodFinal = log2(max(length(fwidth(worldSky)), 1e-6) / texel);
    float lodRay = log2(max(length(fwidth(rdWorld)), 1e-6) / texel);
    float lod = clamp(min(lodFinal, lodRay + 1.5), 0.0, 6.0);
    if (skyWeight > 0.0) col += skyWeight * (textureLod(uSky, worldSky, lod).rgb + crispStars(worldSky) * starGain);

    // Premultiplied output; alpha fades the lensed sky into the unlensed background at the rim.
    float alpha = inside ? 1.0 : 1.0 - smoothstep(0.82, 1.0, rq);
    gl_FragColor = vec4(col * alpha, alpha);
}`;

// Composites the offscreen buffer into the HDR scene, right after the sky background.
const compositeFragment = /* glsl */ `
uniform sampler2D tHole;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tHole, vUv); }`;

// Hot-spot orbits: radius, start angle, brightness, length along the orbit (r_s).
function makeSpots() {
    const spots = [];
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < SPOTS; i++) {
        const radius = 3.5 + Math.pow(random(), 1.4) * 6.5;
        spots.push(new THREE.Vector4(radius, random() * Math.PI * 2, 0.45 + random() * 0.6, 0.7 + random() * 0.9));
    }
    return spots;
}

function fullscreenTriangle() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    return geometry;
}

export function createBlackHole({ renderer, skyTexture, noise, ra = 233, dec = -26, distance = 1700 }) {
    const position = radec(ra, dec).multiplyScalar(distance);
    const scale = distance / DIST_RS;

    // Disk orientation: seen nearly edge-on (camera ~7 degrees above the disk plane) and rolled
    // slightly, the classic angle that shows the far side arching over the top.
    const forward = position.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const up = worldUp.clone().addScaledVector(forward, -worldUp.dot(forward)).normalize();
    up.applyAxisAngle(forward, -10 * DEG);
    const elevation = 7 * DEG;
    const normal = up.clone().multiplyScalar(Math.cos(elevation)).addScaledVector(forward, -Math.sin(elevation)).normalize();
    const diskX = new THREE.Vector3().crossVectors(normal, forward).normalize();
    const diskZ = new THREE.Vector3().crossVectors(diskX, normal).normalize();
    const basis = new THREE.Matrix3().set(
        diskX.x, normal.x, diskZ.x,
        diskX.y, normal.y, diskZ.y,
        diskX.z, normal.z, diskZ.z,
    );

    const uniforms = {
        uSky: { value: skyTexture },
        uNoise: { value: noise },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uBhPos: { value: position },
        uBasis: { value: basis },
        uScale: { value: scale },
        uTime: { value: 0 },
        uSteps: { value: 80 },
        uOctaves: { value: 3 },
        uDPhi: { value: 0.07 },
        uPixelAngle: { value: 0.001 },
        uDiskGain: { value: 0.34 },
        uBeaming: { value: 0.8 },
        uSpin: { value: 1.4 },        // orbital angular speed scale: omega = uSpin * r^-1.5 rad/s
        uSpots: { value: makeSpots() },
    };
    const lensMaterial = new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false,
    });
    const lensScene = new THREE.Scene();
    const lensMesh = new THREE.Mesh(fullscreenTriangle(), lensMaterial);
    lensMesh.frustumCulled = false;
    lensScene.add(lensMesh);
    const lensCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const type = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float")
        ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const target = new THREE.WebGLRenderTarget(1, 1, {
        type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });

    // Drawn in the opaque pass first (renderOrder -1) with premultiplied blending, so it sits
    // right on the background and everything else draws over it.
    const composite = new THREE.Mesh(fullscreenTriangle(), new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: compositeFragment,
        uniforms: { tHole: { value: target.texture } },
        transparent: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
    }));
    composite.frustumCulled = false;
    composite.renderOrder = -1;

    let resolutionScale = 1;
    const size = new THREE.Vector2(1, 1);
    const lensAngle = Math.atan(B_MAX / DIST_RS);
    const toHole = new THREE.Vector3();
    const look = new THREE.Vector3();

    function resizeTarget() {
        target.setSize(Math.max(1, Math.round(size.x * resolutionScale)), Math.max(1, Math.round(size.y * resolutionScale)));
    }

    return {
        mesh: composite,
        position,
        enabled: true,
        get resolutionScale() { return resolutionScale; },
        get bufferSize() { return { x: target.width, y: target.height }; },
        setResolutionScale(value) {
            resolutionScale = THREE.MathUtils.clamp(value, 0.25, 1);
            resizeTarget();
        },
        setSize(width, height) {
            size.set(width, height);
            resizeTarget();
        },
        setTier(tier) {
            uniforms.uSteps.value = tier.bhSteps;
            uniforms.uDPhi.value = THREE.MathUtils.clamp(5.6 / tier.bhSteps, 0.045, 0.12);
            uniforms.uOctaves.value = tier.bhOctaves ?? 3;
        },
        // Ray trace the hole into the offscreen buffer. Skipped entirely when it is off screen.
        render(time, camera) {
            toHole.copy(position).sub(camera.position).normalize();
            camera.getWorldDirection(look);
            const halfDiagonal = Math.atan(Math.tan((camera.fov * DEG) / 2) * Math.hypot(1, camera.aspect));
            const visible = this.enabled && Math.acos(THREE.MathUtils.clamp(look.dot(toHole), -1, 1)) < halfDiagonal + lensAngle;
            composite.visible = visible;
            if (!visible) return false;
            uniforms.uTime.value = time;
            uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
            uniforms.uCamWorld.value.copy(camera.matrixWorld);
            uniforms.uCamPos.value.copy(camera.position);
            uniforms.uPixelAngle.value = (camera.fov * DEG) / target.height;
            const previous = renderer.getRenderTarget();
            renderer.setRenderTarget(target);
            renderer.render(lensScene, lensCamera);
            renderer.setRenderTarget(previous);
            return true;
        },
        // Angular radius of the shadow plus inner disk, for hiding point stars in front of it.
        get shadowAngle() { return Math.atan(3.2 / DIST_RS); },
        get lensRadius() { return Math.atan(R_SPHERE / DIST_RS); },
    };
}
