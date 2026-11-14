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
const DEBRIS = 24;        // glowing fragments of the infalling asteroid
const TIDAL_RADIUS = 6.0; // where the asteroid is torn apart (r_s)

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
uniform vec4 uDebris[${DEBRIS}]; // radius, angle, brightness, tail length (current state, from JS)
uniform int uDebrisCount;
uniform vec2 uDebrisRange;       // radial band the debris occupies, to skip the loop elsewhere
uniform vec4 uRock;              // asteroid centre (local, r_s) and radius
uniform vec4 uRockAxis;          // stretch axis (unit) and stretch factor (tidal elongation)
uniform float uRockOn, uRockHeat, uEmitOut, uFlicker, uInnerFlare;
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
    float turb = 0.0, amp = 0.5, norm = 1e-4, freq = 1.0;
    float radialPx = footprint / max(grazing, 0.035);     // pixel length along the radius
    int octaves = r < DISK_OUT ? uOctaves : 0;              // beyond the disk only debris shines
    for (int o = 0; o < MAX_OCTAVES; o++) {
        if (o >= octaves) break;
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
    spots *= uFlicker;
    density += spots * 0.6 * edgeIn;
    float rim = exp(-pow((r - DISK_IN) / 0.25, 2.0)) * edgeIn * uFlicker * (1.0 + uInnerFlare);   // hot inner edge

    // Asteroid debris: streaks of tidally heated rock spiralling in, tails trailing behind.
    float debris = 0.0;
    int debrisCount = (r > uDebrisRange.x && r < uDebrisRange.y) ? uDebrisCount : 0;
    for (int i = 0; i < ${DEBRIS}; i++) {
        if (i >= debrisCount) break;
        vec4 d = uDebris[i];
        float dphi = mod(phi - d.y + 3.14159265, TAU) - 3.14159265;
        float along = dphi * d.x;
        float tail = along < 0.0 ? d.w : d.w * 0.3;
        float d2 = (along * along) / (tail * tail) + pow((r - d.x) / 0.26, 2.0);
        debris += d.z * exp(-d2);
    }

    // Special-relativistic Doppler shift of orbiting gas plus gravitational redshift.
    float beta = min(sqrt(0.5 / max(r - 1.0, 0.3)), 0.75);
    vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
    float cosTheta = dot(orbit, -normalize(v));
    float gamma = 1.0 / sqrt(1.0 - beta * beta);
    float g = sqrt(max(1.0 - 1.0 / r, 0.0)) / (gamma * (1.0 - beta * cosTheta));
    float beam = mix(1.0, clamp(pow(g, 3.0), 0.05, 7.0), uBeaming);

    vec3 color = palette(temp * mix(1.0, g, 0.9) * 1.05);
    vec3 emission = (color * (flux * density * 3.0 + rim * 1.6) + palette(temp * g * 1.25) * spots * 2.2
                     + palette(mix(0.85, 1.1, min(debris, 1.0)) * mix(1.0, g, 0.9)) * debris * 3.0) * beam * uDiskGain;
    float alpha = clamp(density * 1.15 + rim * 0.5 + debris * 0.45, 0.0, 0.96);
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

// The asteroid is an ellipsoid: a sphere of radius uRock.w stretched by uRockAxis.w along the
// axis (and thinned across it, keeping its volume). Map into the space where it is a sphere.
vec3 toRockSpace(vec3 p) {
    vec3 q = p - uRock.xyz;
    float a = dot(q, uRockAxis.xyz);
    return uRockAxis.xyz * (a / uRockAxis.w) + (q - uRockAxis.xyz * a) * sqrt(uRockAxis.w);
}
// Exact segment / ellipsoid test (an affine map keeps straight segments straight).
bool hitRock(vec3 a, vec3 b, out float t, out vec3 normal) {
    vec3 A = toRockSpace(a), B = toRockSpace(b), D = B - A;
    float rr = uRock.w;
    float qa = dot(D, D), qb = 2.0 * dot(A, D), qc = dot(A, A) - rr * rr;
    float disc = qb * qb - 4.0 * qa * qc;
    if (disc < 0.0 || qa < 1e-8) return false;
    t = (-qb - sqrt(disc)) / (2.0 * qa);
    if (t < 0.0 || t > 1.0) return false;
    vec3 ns = (A + t * D) / rr;
    float k = dot(ns, uRockAxis.xyz);
    normal = normalize(uRockAxis.xyz * k * uRockAxis.w + (ns - uRockAxis.xyz * k) / sqrt(uRockAxis.w));
    return true;
}
// Dark rock lit by the disk (warm, brighter as it falls in), glowing as tides heat it up.
vec3 shadeRock(vec3 p, vec3 n, vec3 dir) {
    float rp = length(p);
    vec3 toHole = -p / rp;
    vec3 toDisk = normalize(vec3(toHole.x, -sign(p.y) * 0.5, toHole.z));
    float light = 2.4 * diskFlux(max(rp * 0.75, DISK_IN * 1.4)) + 0.04;
    vec2 uv = vec2(atan(n.z, n.x) / TAU, n.y * 0.5 + 0.5) * vec2(2.0, 1.0);
    float tex = textureLod(uNoise, uv, 1.0).g;
    vec3 albedo = vec3(0.17, 0.15, 0.13) * (0.55 + 0.9 * tex);
    float lit = max(dot(n, toHole), 0.0) + 0.6 * max(dot(n, toDisk), 0.0);
    vec3 c = albedo * vec3(1.0, 0.72, 0.45) * lit * light * uDiskGain * 4.0;
    float edge = pow(1.0 - abs(dot(n, uRockAxis.xyz)), 0.6);
    // Tidal heating glows most where the rock faces us, fading softly toward its limb.
    float facing = abs(dot(n, dir));
    c += vec3(1.0, 0.36, 0.07) * uRockHeat * uRockHeat * (0.4 + tex) * (0.4 + 0.6 * edge) * facing * facing * 0.9;
    return c;
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
            if (uRockOn > 0.5) {
                // Cheap bounding check first, then the exact ellipsoid test.
                vec3 mid = 0.5 * (prev + pos) - uRock.xyz;
                float reach = 0.5 * seg + uRock.w * uRockAxis.w + 0.1;
                float tRock;
                vec3 nRock;
                if (dot(mid, mid) < reach * reach && hitRock(prev, pos, tRock, nRock)) {
                    col += transmit * shadeRock(mix(prev, pos, tRock), nRock, normalize(pos - prev));
                    transmit = 0.0;
                    break;
                }
            }
            if (prev.y * pos.y < 0.0) {
                float f = prev.y / (prev.y - pos.y);
                vec3 hit = mix(prev, pos, f);
                float rh = length(hit.xz);
                if (rh > DISK_IN * 0.97 && rh < uEmitOut) {
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
    // slightly, the classic angle that shows the far side arching over the top. The disk also
    // precesses slowly (a few degrees of tilt and roll over a minute or two), as disks around
    // spinning black holes do, so the lensed arcs are always gently changing shape.
    const forward = position.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const baseUp = worldUp.clone().addScaledVector(forward, -worldUp.dot(forward)).normalize();
    const basis = new THREE.Matrix3();
    const up = new THREE.Vector3(), normal = new THREE.Vector3(), diskX = new THREE.Vector3(), diskZ = new THREE.Vector3();
    function orientDisk(time) {
        const roll = (-10 + 3.0 * Math.sin((time * Math.PI * 2) / 110 + 1.0)) * DEG;
        const elevation = (7 + 2.2 * Math.sin((time * Math.PI * 2) / 80)) * DEG;
        up.copy(baseUp).applyAxisAngle(forward, roll);
        normal.copy(up).multiplyScalar(Math.cos(elevation)).addScaledVector(forward, -Math.sin(elevation)).normalize();
        diskX.crossVectors(normal, forward).normalize();
        diskZ.crossVectors(diskX, normal).normalize();
        basis.set(
            diskX.x, normal.x, diskZ.x,
            diskX.y, normal.y, diskZ.y,
            diskX.z, normal.z, diskZ.z,
        );
    }
    orientDisk(0);

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
        uDebris: { value: Array.from({ length: DEBRIS }, () => new THREE.Vector4()) },
        uDebrisCount: { value: 0 },
        uDebrisRange: { value: new THREE.Vector2(0, 0) },
        uRock: { value: new THREE.Vector4(0, 0, 0, 0.85) },
        uRockAxis: { value: new THREE.Vector4(1, 0, 0, 1) },
        uRockOn: { value: 0 },
        uRockHeat: { value: 0 },
        uEmitOut: { value: DISK_OUT },
        uFlicker: { value: 1 },
        uInnerFlare: { value: 0 },
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

    // ---- Asteroid event: falls in, is torn apart by tides, and its debris spirals into the disk.
    // Runs on a loop: wait -> fall (plunging orbit, r ~ (1 - t/T)^(2/3)) -> disrupt (stretch,
    // heat, shed debris) -> debris spirals in and flares at the inner edge -> wait.
    const R_START = 14.5, FALL_T = 50, L_MOM = 0.05 * R_START * R_START, K_DEBRIS = 4.3;
    const ev = { state: "wait", t: 6, count: 0, phi: 0, phiCam: 0, side: 1, debris: [], flare: 0, spawn: 0, released: 0 };
    let seed = 99;
    let maxDebris = DEBRIS;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const toLocal = new THREE.Matrix3();
    const camLocal = new THREE.Vector3();
    const rockPos = new THREE.Vector3(), rockPrev = new THREE.Vector3();
    const fallRadius = t => R_START * Math.pow(Math.max(1 - t / FALL_T, 1e-4), 2 / 3);
    function rockPoint(r, phi, out) {
        const incl = 10 * DEG * (r / R_START);                 // settles toward the disk plane as it falls
        return out.set(r * Math.cos(phi), ev.side * r * Math.sin(incl) * Math.cos(phi - ev.phiCam), r * Math.sin(phi));
    }
    function startEvent(camera) {
        toLocal.copy(basis).transpose();
        camLocal.copy(camera.position).sub(position).divideScalar(scale).applyMatrix3(toLocal);
        ev.phiCam = Math.atan2(camLocal.z, camLocal.x);
        ev.side = ev.count % 2 === 0 ? 1 : -1;
        // Pre-run the fall to find how far round it travels, then aim the break-up just in front
        // of the hole, alternating sides.
        let phi = 0, t = 0;
        while (fallRadius(t) > TIDAL_RADIUS) { phi += (L_MOM / fallRadius(t) ** 2) / 30; t += 1 / 30; }
        ev.phi = ev.phiCam + (ev.count % 2 === 0 ? -0.5 : 0.65) - phi;
        ev.state = "fall";
        ev.t = 0;
        ev.released = 0;
        ev.count++;
    }
    function spawnDebris(r, phi) {
        if (ev.debris.length >= DEBRIS) return;
        ev.debris.push({ r: r + (rnd() - 0.5) * 0.7, phi: phi + (rnd() - 0.5) * 0.25, age: 0, gain: 0.6 + rnd() * 0.6 });
    }
    function updateEvent(dt, camera) {
        const u = uniforms;
        ev.t += dt;
        if (ev.state === "wait") {
            u.uRockOn.value = 0;
            if (ev.t > 10 && ev.debris.length === 0) startEvent(camera);
        } else {
            const r = ev.state === "fall" ? fallRadius(ev.t) : Math.max(TIDAL_RADIUS - (ev.t) * 0.55, 3.2);
            ev.phi += (L_MOM / (r * r)) * dt;
            rockPrev.copy(rockPos);
            rockPoint(r, ev.phi, rockPos);
            const heat = THREE.MathUtils.smoothstep(r, 9.5, TIDAL_RADIUS);   // 0 far out, 1 at the tidal radius
            let stretch = 1 + 3 * heat, radius = 0.85 * Math.min(ev.t / 3, 1);
            if (ev.state === "fall" && r <= TIDAL_RADIUS + 0.01) {
                ev.state = "disrupt";
                ev.t = 0;
            }
            if (ev.state === "disrupt") {
                const k = Math.min(ev.t / 3.5, 1);
                stretch = 4 + 6 * k;
                radius = 0.85 * (1 - k * k);
                ev.spawn += dt;
                while (ev.spawn > 0.12) { ev.spawn -= 0.12; spawnDebris(r, ev.phi); }
                if (k >= 1) { ev.state = "wait"; ev.t = 0; }
            }
            const axis = rockPos.clone().sub(rockPrev);
            if (axis.lengthSq() < 1e-10) axis.set(-Math.sin(ev.phi), 0, Math.cos(ev.phi));
            axis.normalize();
            u.uRock.value.set(rockPos.x, rockPos.y, rockPos.z, Math.max(radius, 0.001));
            u.uRockAxis.value.set(axis.x, axis.y, axis.z, stretch);
            u.uRockOn.value = radius > 0.01 ? 1 : 0;
            u.uRockHeat.value = ev.state === "disrupt" ? 1 : heat;
        }
        // Debris: Keplerian spiral inward, brightening as it heats; flares at the inner edge.
        let maxR = DISK_OUT;
        for (let i = ev.debris.length - 1; i >= 0; i--) {
            const d = ev.debris[i];
            d.age += dt;
            d.phi += K_DEBRIS * Math.pow(d.r, -1.5) * dt;
            d.r -= 0.11 * Math.sqrt(TIDAL_RADIUS / d.r) * dt;
            if (d.r < 3.15) {
                ev.flare = Math.min(ev.flare + 0.12, 1.2);
                ev.debris.splice(i, 1);
                continue;
            }
            maxR = Math.max(maxR, d.r + 1);
        }
        // Brightest (newest) fragments first, so a tier that draws fewer keeps the visible ones.
        const shown = ev.debris.slice(-maxDebris);
        let lo = Infinity, hi = 0;
        shown.forEach((d, i) => {
            lo = Math.min(lo, d.r - 0.9);
            hi = Math.max(hi, d.r + 0.9);
            const brightness = Math.min(d.age / 0.8, 1) * Math.pow(TIDAL_RADIUS / d.r, 1.1) * 0.22 * d.gain;
            u.uDebris.value[i].set(d.r, d.phi, brightness, Math.min(0.5 + d.age * 0.4, 5.5));
        });
        u.uDebrisCount.value = shown.length;
        u.uDebrisRange.value.set(shown.length ? lo : 0, shown.length ? hi : 0);
        if (u.uRockOn.value) maxR = Math.max(maxR, rockPos.length() + 1);
        u.uEmitOut.value = Math.min(maxR, R_SPHERE);
        ev.flare *= Math.exp(-dt * 0.9);
        u.uInnerFlare.value = ev.flare;
    }

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
            maxDebris = tier.bhDebris ?? DEBRIS;
        },
        // Ray trace the hole into the offscreen buffer. Skipped entirely when it is off screen.
        render(time, camera, dt = 1 / 60) {
            orientDisk(time);
            updateEvent(Math.min(dt, 0.1), camera);
            uniforms.uFlicker.value = 1 + 0.06 * Math.sin(time * 1.7) + 0.04 * Math.sin(time * 4.3 + 1) + 0.03 * Math.sin(time * 9.1 + 2);
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
        get event() { return ev; },
        // Development helper (used via ?debug): fast-forward the asteroid event.
        advanceEvent(seconds, camera) {
            for (let t = 0; t < seconds; t += 0.05) updateEvent(0.05, camera);
        },
    };
}
