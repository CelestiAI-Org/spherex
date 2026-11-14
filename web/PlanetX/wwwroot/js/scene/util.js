import * as THREE from "./three.js";

export const DEG = Math.PI / 180;

// World frame = equatorial (J2000): +Y is the north celestial pole, RA 0 is +X and RA
// increases toward -Z, so from inside the sphere east is to the left of north, as on the sky.
export function radec(raDeg, decDeg, out = new THREE.Vector3()) {
    const ra = raDeg * DEG;
    const dec = decDeg * DEG;
    return out.set(Math.cos(dec) * Math.cos(ra), Math.sin(dec), -Math.cos(dec) * Math.sin(ra));
}

export function toRaDec(v) {
    const n = v.clone().normalize();
    let ra = Math.atan2(-n.z, n.x) / DEG;
    if (ra < 0) ra += 360;
    return { ra, dec: Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)) / DEG };
}

// Galactic frame (IAU J2000 north galactic pole and galactic centre) expressed in world axes,
// so the Milky Way band sits where it really is on the sky.
export const GALACTIC = (() => {
    const north = radec(192.85948, 27.12825);
    const towardCenter = radec(266.40510, -28.93617);
    const center = towardCenter.clone().sub(north.clone().multiplyScalar(towardCenter.dot(north))).normalize();
    const y = new THREE.Vector3().crossVectors(north, center).normalize();
    return { north, center, y };
})();

export function galactic(lRad, bRad, out = new THREE.Vector3()) {
    const cb = Math.cos(bRad);
    return out
        .copy(GALACTIC.center).multiplyScalar(cb * Math.cos(lRad))
        .addScaledVector(GALACTIC.y, cb * Math.sin(lRad))
        .addScaledVector(GALACTIC.north, Math.sin(bRad));
}

// Small seeded PRNG (mulberry32) so the sky is identical on every reload.
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function gaussian(random) {
    const u = Math.max(random(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export const ease = {
    inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outCubic: t => 1 - Math.pow(1 - t, 3),
    inCubic: t => t * t * t,
    inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
};

export const clamp01 = x => Math.min(1, Math.max(0, x));
export const damp = (current, target, lambda, dt) => THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Places a flat quad so it faces the origin (where the camera lives).
export function faceOrigin(object) {
    object.lookAt(0, 0, 0);
    return object;
}
