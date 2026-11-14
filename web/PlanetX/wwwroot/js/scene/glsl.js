// Shared GLSL snippets.

// Hash functions: "Hash without Sine" by Dave Hoskins (MIT licence, see CREDITS.md).
export const HASH = /* glsl */ `
float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
`;

// 3D value noise with quintic fade, and fractal sums of it.
export const NOISE3 = /* glsl */ `
${HASH}
float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash13(i);
    float b = hash13(i + vec3(1, 0, 0));
    float c = hash13(i + vec3(0, 1, 0));
    float d = hash13(i + vec3(1, 1, 0));
    float e = hash13(i + vec3(0, 0, 1));
    float f1 = hash13(i + vec3(1, 0, 1));
    float g = hash13(i + vec3(0, 1, 1));
    float h = hash13(i + vec3(1, 1, 1));
    return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm(vec3 p, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= octaves) break;
        sum += amp * vnoise(p);
        norm += amp;
        p = p * 2.03 + vec3(17.1, 9.2, 4.7);
        amp *= 0.5;
    }
    return sum / norm;
}
float ridged(vec3 p, int octaves) {
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= octaves) break;
        float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
        sum += amp * n * n;
        norm += amp;
        p = p * 2.07 + vec3(3.3, 11.9, 7.1);
        amp *= 0.5;
    }
    return sum / norm;
}
`;

// Narkowicz's ACES filmic fit, then linear -> sRGB.
export const TONEMAP = /* glsl */ `
vec3 acesFilm(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 linearToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;
