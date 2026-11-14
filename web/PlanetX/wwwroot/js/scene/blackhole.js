import * as THREE from "./three.js";
import { NOISE3 } from "./glsl.js";
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
const FRAGMENTS = 8;      // glowing pieces peeling off during the break-up
const CRATERS = 6;

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fragmentShader = /* glsl */ `
#define MAX_STEPS 160
#define USE_SHARDS 0
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
uniform vec4 uRock;              // asteroid centre (disk frame, r_s) and radius
uniform vec4 uRockAxis;          // tidal stretch axis (unit) and stretch factor
uniform mat3 uRockRot;           // rock -> disk frame rotation (tumbling)
uniform vec4 uCraters[${CRATERS}];   // crater centre direction (rock frame) and angular radius
uniform vec4 uFrag[${FRAGMENTS}];    // fragment centre and radius
uniform vec4 uFragAxis[${FRAGMENTS}];// fragment stretch axis and stretch
uniform float uFragHeat[${FRAGMENTS}];
uniform int uFragCount;
uniform float uRockOn, uRockHeat, uEmitOut, uFlicker, uInnerFlare;
uniform float uDiskFade;        // 0..1, used by the intro: the disk lights up from its inner edge outward
uniform float uRingBoost;       // photon-ring brightness (the intro lets it ignite first)
varying vec2 vUv;
${NOISE3}

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

// Intro ignition: how lit the disk is at radius r, with a hotter front where it is spreading.
float diskIgnite(float r) {
    if (uDiskFade >= 0.999) return 1.0;
    float x = (r - DISK_IN) / (DISK_OUT - DISK_IN);
    float lit = clamp((uDiskFade * 1.35 - x) / 0.35, 0.0, 1.0);
    float front = exp(-pow((x - (uDiskFade * 1.35 - 0.1)) / 0.1, 2.0)) * (1.0 - uDiskFade);
    return lit * (1.0 + 2.0 * front);
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

// ---- Asteroid. A signed-distance-field rock: an irregular base shape, lumps from 3D value
// noise and a few bowl craters with raised rims. It tumbles (uRockRot) and near the hole is
// stretched along its orbit by tides (uRockAxis). It is sphere traced inside each ray step, so
// it is lensed, appears in secondary images and is hidden by the shadow like everything else.
vec3 rockLocal(vec3 p) {
    vec3 q = p - uRock.xyz;
    float a = dot(q, uRockAxis.xyz);
    q = uRockAxis.xyz * (a / uRockAxis.w) + (q - uRockAxis.xyz * a) * sqrt(uRockAxis.w);
    return transpose(uRockRot) * q / uRock.w;
}
float rockShape(vec3 lp) {
    float base = length(lp * vec3(0.92, 1.18, 0.82)) - 1.0;           // potato, not a sphere
    float lumps = vnoise(lp * 1.6 + 3.1) * 0.42 + vnoise(lp * 3.7 + 7.7) * 0.14 + vnoise(lp * 8.3 + 1.3) * 0.04;
    vec3 dir = normalize(lp);
    float craters = 0.0;
    for (int i = 0; i < ${CRATERS}; i++) {
        float x = length(dir - uCraters[i].xyz) / uCraters[i].w;
        craters += x < 1.0 ? (x * x - 1.0) * 0.16 : 0.0;                // bowl
        craters += exp(-pow((x - 1.0) / 0.28, 2.0)) * 0.045;            // raised rim
    }
    return base - lumps + 0.2 - craters;
}
// Distance in disk-frame units (conservative for the stretch and the noise).
float rockSdf(vec3 p) {
    return rockShape(rockLocal(p)) * uRock.w / sqrt(uRockAxis.w) * 0.55;
}
bool traceRock(vec3 a, vec3 b, out vec3 hitPos) {
    vec3 d = b - a;
    float len = length(d);
    d /= len;
    float rb = uRock.w * 1.55 * uRockAxis.w;                             // bounding sphere
    vec3 oc = a - uRock.xyz;
    float pb = dot(oc, d), pc = dot(oc, oc) - rb * rb;
    float disc = pb * pb - pc;
    if (disc < 0.0) return false;
    float sq = sqrt(disc);
    float t = max(-pb - sq, 0.0), t1 = min(-pb + sq, len);
    if (t > t1) return false;
    float eps = 0.004 * uRock.w;
    for (int i = 0; i < 32; i++) {
        vec3 p = a + d * t;
        float dist = rockSdf(p);
        if (dist < eps) { hitPos = p; return true; }
        t += max(dist, eps);
        if (t > t1) return false;
    }
    return false;
}
vec3 rockNormal(vec3 p) {
    float e = 0.012 * uRock.w;
    vec2 k = vec2(1.0, -1.0);
    return normalize(k.xyy * rockSdf(p + k.xyy * e) + k.yyx * rockSdf(p + k.yyx * e)
                   + k.yxy * rockSdf(p + k.yxy * e) + k.xxx * rockSdf(p + k.xxx * e));
}
// Hard warm key light from the inner disk, softer light from the disk plane, dark ambient,
// thin cool rim, crater occlusion; when tidally heated, glowing fissures.
vec3 shadeRock(vec3 p, vec3 dir) {
    vec3 n = rockNormal(p);
    vec3 lp = rockLocal(p);
    // Fine surface relief from the gradient of high-frequency noise.
    float h0 = vnoise(lp * 11.0);
    vec3 g = vec3(vnoise(lp * 11.0 + vec3(0.06, 0, 0)), vnoise(lp * 11.0 + vec3(0, 0.06, 0)), vnoise(lp * 11.0 + vec3(0, 0, 0.06))) - h0;
    n = normalize(n - uRockRot * g * 5.0);
    float rp = length(p);
    vec3 key = -p / rp;
    vec3 fill = normalize(vec3(-p.x * 0.4, -sign(p.y) * 1.0, -p.z * 0.4));
    float light = 2.6 * diskFlux(max(rp * 0.7, DISK_IN * 1.35)) + 0.35;
    float ao = clamp(rockSdf(p + n * 0.25 * uRock.w) / (0.25 * uRock.w * 0.55), 0.0, 1.0);
    float albedo = 0.09 + 0.09 * vnoise(lp * 3.2 + 5.0) + 0.04 * h0;
    vec3 c = albedo * vec3(1.0, 0.7, 0.45) * light * (max(dot(n, key), 0.0) + 0.3 * max(dot(n, fill), 0.0)) * (0.45 + 0.55 * ao);
    c += albedo * vec3(0.5, 0.6, 0.8) * 0.012;                                         // dark ambient
    c += vec3(0.5, 0.65, 1.0) * pow(1.0 - max(dot(n, -dir), 0.0), 4.0) * 0.06 * light;  // thin rim
    // Tidal heating: thin glowing fissures (ridges of the noise), not blotches.
    // Tidal heating: a branching crack network (ridged fBm, mapped over the rock's surface)
    // that opens up and glows as tides heat the rock, plus a dull glow on the face toward the hole.
    vec3 sd = normalize(lp);
    vec2 suv = vec2(atan(sd.z, sd.x) / TAU, acos(clamp(sd.y, -1.0, 1.0)) / 3.14159265) * vec2(2.0, 1.0);
    float network = textureLod(uNoise, suv * 1.5, 0.0).b;
    float cracks = smoothstep(0.82 - 0.12 * uRockHeat, 0.97, network) * smoothstep(0.15, 0.8, uRockHeat);
    c += vec3(1.0, 0.32, 0.05) * cracks * 1.4 * uRockHeat;
    c += vec3(0.45, 0.08, 0.01) * uRockHeat * uRockHeat * max(dot(n, key), 0.0) * 0.12;
    return c * uDiskGain * 3.0;
}

#if USE_SHARDS
// Fragments: small glowing shards (ellipsoids stretched along their orbits).
bool hitShard(int i, vec3 a, vec3 b, out float t, out vec3 normal) {
    vec4 f = uFrag[i], ax = uFragAxis[i];
    vec3 qa = a - f.xyz, qb = b - f.xyz;
    float ka = dot(qa, ax.xyz), kb = dot(qb, ax.xyz);
    vec3 A = ax.xyz * (ka / ax.w) + (qa - ax.xyz * ka) * sqrt(ax.w);
    vec3 B = ax.xyz * (kb / ax.w) + (qb - ax.xyz * kb) * sqrt(ax.w);
    vec3 D = B - A;
    float qq = dot(D, D), q1 = 2.0 * dot(A, D), q0 = dot(A, A) - f.w * f.w;
    float disc = q1 * q1 - 4.0 * qq * q0;
    if (disc < 0.0 || qq < 1e-10) return false;
    t = (-q1 - sqrt(disc)) / (2.0 * qq);
    if (t < 0.0 || t > 1.0) return false;
    vec3 ns = (A + t * D) / f.w;
    float k = dot(ns, ax.xyz);
    normal = normalize(ax.xyz * k * ax.w + (ns - ax.xyz * k) / sqrt(ax.w));
    return true;
}
vec3 shadeShard(int i, vec3 p, vec3 n, vec3 dir) {
    float heat = uFragHeat[i];
    float facing = max(dot(n, -dir), 0.0);
    float rp = length(p);
    float light = 2.6 * diskFlux(max(rp * 0.7, DISK_IN * 1.35)) + 0.35;
    vec3 rock = vec3(0.12, 0.09, 0.07) * light * max(dot(n, -p / rp), 0.0);
    float hot = max(dot(n, -p / rp), 0.0);                       // glowing on the face toward the hole
    vec3 glow = mix(vec3(0.7, 0.12, 0.02), vec3(1.0, 0.55, 0.18), hot) * (0.25 + 0.75 * hot) * (0.4 + 0.6 * facing) * heat * 1.5;
    return (rock + glow) * uDiskGain * 3.0;
}
#endif

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
        bool rockCandidate = false;
        vec3 rockA = vec3(0.0), rockB = vec3(0.0), colAtRock = vec3(0.0);
        float transmitAtRock = 1.0;
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
            if (uRockOn > 0.5 && !rockCandidate) {
                // Only flag the first step that could touch the rock (cheap). The rock itself is
                // traced and shaded once after the loop, which keeps this loop small and fast.
                vec3 mid = 0.5 * (prev + pos) - uRock.xyz;
                float reach = 0.5 * seg + uRock.w * 1.6 * uRockAxis.w;
                if (dot(mid, mid) < reach * reach) {
                    rockCandidate = true;
                    rockA = prev;
                    rockB = pos;
                    colAtRock = col;
                    transmitAtRock = transmit;
                }
            }
#if USE_SHARDS
            if (uFragCount > 0) {
                bool shardHit = false;
                for (int k = 0; k < ${FRAGMENTS}; k++) {
                    if (k >= uFragCount) break;
                    vec3 mid = 0.5 * (prev + pos) - uFrag[k].xyz;
                    float reach = 0.5 * seg + uFrag[k].w * uFragAxis[k].w;
                    float tS;
                    vec3 nS;
                    if (dot(mid, mid) < reach * reach && hitShard(k, prev, pos, tS, nS)) {
                        col += transmit * shadeShard(k, mix(prev, pos, tS), nS, normalize(pos - prev));
                        transmit = 0.0;
                        shardHit = true;
                        break;
                    }
                }
                if (shardHit) break;
            }
#endif
            if (prev.y * pos.y < 0.0) {
                float f = prev.y / (prev.y - pos.y);
                vec3 hit = mix(prev, pos, f);
                float rh = length(hit.xz);
                if (rh > DISK_IN * 0.97 && rh < uEmitOut) {
                    vec3 dir = (pos - prev) / max(seg, 1e-5);
                    vec4 e = disk(hit, dir, uPixelAngle * (travelled + seg * f), abs(dir.y));
                    float ignite = diskIgnite(rh);
                    e.rgb *= ignite;
                    e.a *= min(ignite, 1.0);
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
        // The rock, if a step came near it: everything gathered after that step lies behind it.
        if (rockCandidate) {
            vec3 rockHit;
            if (traceRock(rockA, rockB, rockHit)) {
                col = colAtRock + transmitAtRock * shadeRock(rockHit, normalize(rockB - rockA));
                transmit = 0.0;
                glow = 0.0;
                captured = true;
            }
        }
        // Rays still circling close to the hole when the step budget runs out are absorbed.
        if (!escaped && !captured && 1.0 / max(u, 1e-4) < 2.5) captured = true;
        col += vec3(1.0, 0.78, 0.5) * glow * 0.025 * uDiskGain * uDiskFade;
        // The photon-ring glow belongs to rays that skim the photon sphere and get away.
        if (!captured) col += vec3(1.0, 0.86, 0.68) * ringGlow * 0.4 * uDiskGain * (0.25 + 0.75 * uDiskFade) * uRingBoost;
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
    // Guard the half-float buffer: no NaN / Inf (white or black flashes) and nothing near its 65504 limit.
    if (!(col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0 && col.r + col.g + col.b < 1e30)) col = vec3(0.0);
    col = min(col, vec3(1e3));
    gl_FragColor = vec4(col * alpha, alpha);
}`;

// Composites the offscreen buffer into the HDR scene, right after the sky background.
const compositeFragment = /* glsl */ `
uniform sampler2D tHole;
uniform float uFade;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tHole, vUv) * uFade; }`;

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
        uRock: { value: new THREE.Vector4(0, 0, 0, 0.36) },
        uRockAxis: { value: new THREE.Vector4(1, 0, 0, 1) },
        uRockOn: { value: 0 },
        uRockRot: { value: new THREE.Matrix3() },
        uCraters: { value: Array.from({ length: CRATERS }, () => new THREE.Vector4(1, 0, 0, 0.3)) },
        uFrag: { value: Array.from({ length: FRAGMENTS }, () => new THREE.Vector4()) },
        uFragAxis: { value: Array.from({ length: FRAGMENTS }, () => new THREE.Vector4(1, 0, 0, 1)) },
        uFragHeat: { value: new Array(FRAGMENTS).fill(0) },
        uFragCount: { value: 0 },
        uRockHeat: { value: 0 },
        uEmitOut: { value: DISK_OUT },
        uFlicker: { value: 1 },
        uInnerFlare: { value: 0 },
        uDiskFade: { value: 1 },
        uRingBoost: { value: 1 },
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
        uniforms: { tHole: { value: target.texture }, uFade: { value: 1 } },
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

    // ---- Asteroid event (?asteroid=off disables it). Loop: wait -> fall -> disrupt -> wait.
    //  fall:    a small tumbling rock emerges from behind the hole on a plunging orbit,
    //           r ~ (1 - t/T)^(2/3) with conserved angular momentum. It stays a plain solid rock
    //           until it is close; only inside ~9 r_s do tides start to stretch and heat it.
    //  disrupt: at 6 r_s glowing shards peel off its surface one by one and fall in on their own
    //           slightly different orbits, stretching as they go; the rock shrinks and finally
    //           shatters. Shards that reach ~4.5 r_s turn into the disk debris stream, which
    //           spirals in and flares the inner edge.
    const R_START = 14.5, FALL_T = 50, L_MOM = 0.05 * R_START * R_START, K_DEBRIS = 4.3, ROCK_R = 0.36;
    // Off by default (it is tiny at this scale and flickers as it crosses the disk layers); ?asteroid=on enables it.
    const asteroidOn = new URLSearchParams(location.search).get("asteroid") === "on";
    const ev = { state: "wait", t: 6, count: 0, phi: 0, phiCam: 0, side: 1, debris: [], shards: [], flare: 0, spawn: 0, r: R_START };
    let seed = 99;
    let maxDebris = DEBRIS;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const toLocal = new THREE.Matrix3();
    const camLocal = new THREE.Vector3();
    const rockPos = new THREE.Vector3(), rockPrev = new THREE.Vector3(), tmp = new THREE.Vector3();
    const tumbleAxis = new THREE.Vector3(0.3, 1, 0.2).normalize();
    const tumble = new THREE.Quaternion(), spin = new THREE.Quaternion();
    const rot4 = new THREE.Matrix4();
    const smooth = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const fallRadius = t => R_START * Math.pow(Math.max(1 - t / FALL_T, 1e-4), 2 / 3);
    function orbitPoint(r, phi, out, tilt = 1) {
        const incl = 10 * DEG * (r / R_START) * tilt;          // settles toward the disk plane as it falls
        return out.set(r * Math.cos(phi), ev.side * r * Math.sin(incl) * Math.cos(phi - ev.phiCam), r * Math.sin(phi));
    }
    function newCraters() {
        return Array.from({ length: CRATERS }, () => {
            const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
            return new THREE.Vector4(v.x, v.y, v.z, 0.22 + rnd() * 0.3);
        });
    }
    function startEvent(camera) {
        toLocal.copy(basis).transpose();
        camLocal.copy(camera.position).sub(position).divideScalar(scale).applyMatrix3(toLocal);
        ev.phiCam = Math.atan2(camLocal.z, camLocal.x);
        ev.side = ev.count % 2 === 0 ? 1 : -1;
        // Pre-run the fall to find how far round it travels, then aim the break-up in front of
        // the hole, alternating sides.
        let phi = 0, t = 0;
        while (fallRadius(t) > TIDAL_RADIUS) { phi += (L_MOM / fallRadius(t) ** 2) / 30; t += 1 / 30; }
        ev.phi = ev.phiCam + (ev.count % 2 === 0 ? -0.5 : 0.65) - phi;
        ev.state = "fall";
        ev.t = 0;
        ev.count++;
        tumbleAxis.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
        uniforms.uCraters.value = newCraters();
    }
    // Solid shard objects (uFrag) read as flat blobs at this scale, so by default the break-up sheds
    // thin glowing debris streaks instead. Set USE_SHARDS to true to bring the shards back.
    const USE_SHARDS = false;
    function peelShard() {
        if (!USE_SHARDS) {
            for (let i = 0; i < 3; i++) spawnDebris(ev.r, ev.phi - i * 0.04);
            return;
        }
        if (ev.shards.length >= FRAGMENTS) return;
        ev.shards.push({
            r: ev.r + (rnd() - 0.4) * 0.5, phi: ev.phi + (rnd() - 0.5) * 0.12, dy: (rnd() - 0.5) * 0.5,
            vr: 0.25 + rnd() * 0.35, omega: 0.85 + rnd() * 0.35, age: 0,
            size: ROCK_R * (0.26 + rnd() * 0.22), pos: new THREE.Vector3(), prev: new THREE.Vector3(),
        });
    }
    function updateEvent(dt, camera) {
        const u = uniforms;
        ev.t += dt;
        if (!asteroidOn) { u.uRockOn.value = 0; u.uFragCount.value = 0; u.uDebrisCount.value = 0; return; }
        let radius = 0;
        if (ev.state === "wait") {
            if (ev.t > 10 && ev.debris.length === 0 && ev.shards.length === 0) startEvent(camera);
        } else {
            ev.r = ev.state === "fall" ? fallRadius(ev.t) : Math.max(TIDAL_RADIUS - ev.t * 0.35, 4.2);
            ev.phi += (L_MOM / (ev.r * ev.r)) * dt;
            rockPrev.copy(rockPos);
            orbitPoint(ev.r, ev.phi, rockPos);
            const heat = smooth(7.6, TIDAL_RADIUS, ev.r);                 // 0 until close, 1 at the tidal radius
            let stretch = 1 + 0.35 * heat;
            radius = ROCK_R * Math.min(ev.t / 2.5, 1);
            if (ev.state === "fall" && ev.r <= TIDAL_RADIUS + 0.01) {
                ev.state = "disrupt";
                ev.t = 0;
                ev.spawn = 0;
            }
            if (ev.state === "disrupt") {
                const k = Math.min(ev.t / 4.5, 1);
                stretch = 1.35 + 0.9 * k;
                radius = ROCK_R * (1 - 0.55 * k);
                ev.spawn += dt;
                while (ev.spawn > 0.35) { ev.spawn -= 0.35; peelShard(); }
                if (k >= 1) {                                         // the remaining core shatters
                    for (let i = 0; i < 3; i++) peelShard();
                    radius = 0;
                    ev.state = "wait";
                    ev.t = 0;
                }
            }
            const axis = tmp.copy(rockPos).sub(rockPrev);
            if (axis.lengthSq() < 1e-10) axis.set(-Math.sin(ev.phi), 0, Math.cos(ev.phi));
            axis.normalize();
            spin.setFromAxisAngle(tumbleAxis, dt * 0.55);
            tumble.premultiply(spin).normalize();
            u.uRockRot.value.setFromMatrix4(rot4.makeRotationFromQuaternion(tumble));
            u.uRock.value.set(rockPos.x, rockPos.y, rockPos.z, Math.max(radius, 0.001));
            u.uRockAxis.value.set(axis.x, axis.y, axis.z, stretch);
            u.uRockHeat.value = ev.state === "disrupt" ? 1 : heat;
        }
        u.uRockOn.value = radius > 0.01 ? 1 : 0;

        // Shards: each falls on its own orbit, stretching and glowing; deep in they join the stream.
        for (let i = ev.shards.length - 1; i >= 0; i--) {
            const f = ev.shards[i];
            f.age += dt;
            f.r -= f.vr * dt * Math.sqrt(TIDAL_RADIUS / f.r);
            f.phi += f.omega * (L_MOM / (f.r * f.r)) * dt;
            f.prev.copy(f.pos);
            orbitPoint(f.r, f.phi, f.pos, 0.7).y += f.dy * Math.max(1 - f.age / 4, 0) * 0.3;
            if (f.r < 4.5 || f.age > 7) {
                for (let k = 0; k < 3; k++) spawnDebris(f.r, f.phi);
                ev.shards.splice(i, 1);
            }
        }
        ev.shards.slice(0, FRAGMENTS).forEach((f, i) => {
            const ax = tmp.copy(f.pos).sub(f.prev);
            if (ax.lengthSq() < 1e-10) ax.set(-Math.sin(f.phi), 0, Math.cos(f.phi));
            ax.normalize();
            u.uFrag.value[i].set(f.pos.x, f.pos.y, f.pos.z, f.size * Math.min(f.age / 0.4, 1));
            u.uFragAxis.value[i].set(ax.x, ax.y, ax.z, 1.5 + f.age * 1.1);
            u.uFragHeat.value[i] = Math.min(0.5 + f.age * 0.35, 1.3);
        });
        u.uFragCount.value = Math.min(ev.shards.length, FRAGMENTS);

        // Debris stream in the disk plane: Keplerian spiral inward, flares at the inner edge.
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
        const shown = ev.debris.slice(-maxDebris);
        let lo = Infinity, hi = 0;
        shown.forEach((d, i) => {
            lo = Math.min(lo, d.r - 0.9);
            hi = Math.max(hi, d.r + 0.9);
            const brightness = Math.min(d.age / 0.8, 1) * Math.pow(TIDAL_RADIUS / d.r, 1.1) * 0.2 * d.gain;
            u.uDebris.value[i].set(d.r, d.phi, brightness, Math.min(1.6 + d.age * 0.6, 6.5));
        });
        u.uDebrisCount.value = shown.length;
        u.uDebrisRange.value.set(shown.length ? lo : 0, shown.length ? hi : 0);
        if (u.uRockOn.value) maxR = Math.max(maxR, rockPos.length() + 1);
        u.uEmitOut.value = Math.min(maxR, R_SPHERE);
        ev.flare *= Math.exp(-dt * 0.9);
        u.uInnerFlare.value = ev.flare;
    }
    function spawnDebris(r, phi) {
        if (ev.debris.length >= DEBRIS) return;
        ev.debris.push({ r: r + (rnd() - 0.5) * 0.5, phi: phi + (rnd() - 0.5) * 0.2, age: 0, gain: 0.6 + rnd() * 0.6 });
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
            const visible = this.enabled && composite.material.uniforms.uFade.value > 0.001 && Math.acos(THREE.MathUtils.clamp(look.dot(toHole), -1, 1)) < halfDiagonal + lensAngle;
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
        // Intro control: lens fades the whole lensed view in, disk fades the accretion disk in.
        setFade(lens, disk, ring = 1) {
            composite.material.uniforms.uFade.value = lens;
            uniforms.uDiskFade.value = disk;
            uniforms.uRingBoost.value = ring;
        },
        // Development helper: the asteroid's world position (for aiming the camera at it).
        rockWorld() {
            const r = uniforms.uRock.value;
            return new THREE.Vector3(r.x, r.y, r.z).applyMatrix3(basis).multiplyScalar(scale).add(position);
        },
        // Development helper (used via ?debug): fast-forward the asteroid event.
        advanceEvent(seconds, camera) {
            for (let t = 0; t < seconds; t += 0.05) updateEvent(0.05, camera);
        },
    };
}
