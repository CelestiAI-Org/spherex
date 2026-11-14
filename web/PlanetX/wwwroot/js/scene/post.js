import * as THREE from "./three.js";
import { HASH, TONEMAP } from "./glsl.js";

// Cinematic post-processing, written for this project:
//  HDR scene -> bloom mip chain (13-tap downsample with a Karis firefly filter, tent upsample)
//  -> composite: chromatic aberration, warp zoom blur, bloom, pseudo lens flare, anamorphic
//     streak, exposure, ACES, grade, vignette, grain + dither.

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const downsampleFragment = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
uniform bool uPrefilter;
varying vec2 vUv;
vec3 s(vec2 o) { return min(texture2D(tSrc, vUv + uTexel * o).rgb, vec3(6e4)); }
vec3 prefilter(vec3 c) {
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = rq * rq / (4.0 * uKnee + 1e-4);
    return c * max(rq, br - uThreshold) / max(br, 1e-4);
}
float karis(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main() {
    vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
    vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
    vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
    vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
    vec3 result;
    if (uPrefilter) {
        vec3 g0 = prefilter((j + k + l + m) * 0.25);
        vec3 g1 = prefilter((a + b + d + e) * 0.25);
        vec3 g2 = prefilter((b + c + e + f) * 0.25);
        vec3 g3 = prefilter((d + e + g + h) * 0.25);
        vec3 g4 = prefilter((e + f + h + i) * 0.25);
        float w0 = 0.5 * karis(g0), w1 = 0.125 * karis(g1), w2 = 0.125 * karis(g2), w3 = 0.125 * karis(g3), w4 = 0.125 * karis(g4);
        result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    } else {
        result = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    }
    gl_FragColor = vec4(result, 1.0);
}`;

const upsampleFragment = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius, uWeight;
varying vec2 vUv;
void main() {
    vec2 t = uTexel * uRadius;
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += (texture2D(tSrc, vUv + vec2(-t.x, 0)).rgb + texture2D(tSrc, vUv + vec2(t.x, 0)).rgb
        + texture2D(tSrc, vUv + vec2(0, -t.y)).rgb + texture2D(tSrc, vUv + vec2(0, t.y)).rgb) * 2.0;
    c += texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb
       + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb;
    gl_FragColor = vec4(c / 16.0 * uWeight, 1.0);
}`;

const compositeFragment = /* glsl */ `
uniform sampler2D tScene, tBloom, tFlare, tStreak;
uniform vec2 uResolution, uStreakTexel;
uniform float uTime, uExposure, uBloom, uFlare, uStreak, uCA, uGrain, uVignette, uDesaturate;
uniform float uZoomBlur, uWarm, uFlash;
uniform vec2 uZoomCenter;
uniform vec4 uRipple;        // centre (uv), radius (screen heights), strength
uniform float uRippleRefract, uRippleWidth;
varying vec2 vUv;
${HASH}
${TONEMAP}
vec3 sceneCA(vec2 uv) {
    vec2 d = uv - 0.5;
    vec2 off = d * dot(d, d) * uCA * 0.012;
    return vec3(texture2D(tScene, uv - off).r, texture2D(tScene, uv).g, texture2D(tScene, uv + off).b);
}
void main() {
    vec2 uv = vUv;
    vec3 col;
    // Supernova shockwave: a ring that refracts the view as it passes (derivative-of-Gaussian
    // displacement), with a faint chromatic fringe. Low tier: no refraction, just a soft ring.
    float ringLight = 0.0;
    if (uRipple.w > 0.0) {
        vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
        vec2 d = (uv - uRipple.xy) * aspect;
        float dist = length(d);
        float x = (dist - uRipple.z) / uRippleWidth;
        float g = exp(-x * x);
        ringLight = g * uRipple.w * 6.0;
        if (uRippleRefract > 0.5) {
            vec2 off = (d / max(dist, 1e-4)) / aspect * (x * g) * uRipple.w;
            col = vec3(sceneCA(uv - off * 1.25).r, sceneCA(uv - off).g, sceneCA(uv - off * 0.75).b);
            uv -= off;
        } else {
            col = sceneCA(uv);
        }
    } else {
        col = sceneCA(uv);
    }

    // Warp zoom: radial blur toward the flight target.
    if (uZoomBlur > 0.001) {
        vec2 dir = uv - uZoomCenter;
        vec3 acc = col;
        float jitter = hash12(uv * uResolution + uTime);
        for (int i = 1; i <= 10; i++) {
            float k = (float(i) + jitter) / 10.0;
            acc += texture2D(tScene, uv - dir * uZoomBlur * k * 0.18).rgb;
        }
        col = acc / 11.0;
    }

    vec3 bloom = texture2D(tBloom, uv).rgb;
    col += bloom * uBloom;
    col += vec3(0.7, 0.82, 1.0) * ringLight * 0.14;

    // Pseudo lens flare: ghosts of bright sources mirrored through the frame centre.
    if (uFlare > 0.0) {
        vec2 flipped = vec2(1.0) - uv;
        vec2 ghostVec = (vec2(0.5) - flipped) * 0.45;
        vec3 flare = vec3(0.0);
        for (int i = 0; i < 4; i++) {
            vec2 o = flipped + ghostVec * float(i);
            float w = pow(max(1.0 - length(vec2(0.5) - o) / 0.7071, 0.0), 8.0);
            vec3 tint = i == 0 ? vec3(0.6, 0.8, 1.0) : i == 1 ? vec3(1.0, 0.7, 0.45) : i == 2 ? vec3(0.55, 1.0, 0.75) : vec3(0.9, 0.6, 1.0);
            flare += max(texture2D(tFlare, o).rgb - 0.15, 0.0) * w * tint;
        }
        vec2 haloVec = normalize(ghostVec + 1e-5) * 0.42;
        float hw = pow(max(1.0 - length(vec2(0.5) - (flipped + haloVec)) / 0.7071, 0.0), 6.0);
        flare += max(texture2D(tFlare, flipped + haloVec).rgb - 0.15, 0.0) * hw * vec3(0.5, 0.65, 1.0) * 0.6;
        col += flare * uFlare;
    }

    // Anamorphic streak: a thin horizontal smear of the brightest light, slightly blue.
    if (uStreak > 0.0) {
        vec3 streak = vec3(0.0);
        for (int i = -7; i <= 7; i++) {
            float w = exp(-abs(float(i)) * 0.32);
            streak += max(texture2D(tStreak, uv + vec2(float(i) * uStreakTexel.x, 0.0)).rgb - 0.25, 0.0) * w;
        }
        col += streak * vec3(0.45, 0.62, 1.0) * uStreak * (1.0 - clamp(uZoomBlur * 2.0, 0.0, 1.0));
    }

    col *= uExposure;
    col += uFlash * vec3(1.0, 0.92, 0.8);
    col = acesFilm(col);

    // Grade: cool, slightly lifted shadows; warm highlights; optional warm push during warp.
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, col * vec3(0.92, 1.0, 1.1) + vec3(0.0, 0.004, 0.012), 1.0 - smoothstep(0.0, 0.35, luma));
    col = mix(col, col * vec3(1.08, 1.0, 0.9), smoothstep(0.45, 1.0, luma) * 0.6);
    col = mix(col, col * vec3(1.25, 0.98, 0.72) + vec3(0.02, 0.008, 0.0), uWarm);
    col = mix(col, vec3(luma), uDesaturate);

    vec2 d = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    col *= mix(1.0, smoothstep(1.25, 0.25, length(d)), uVignette);

    col = linearToSrgb(col);
    float n = hash12(uv * uResolution + fract(uTime * 7.13) * 100.0) - 0.5;
    col += n * uGrain + (hash12(uv * uResolution * 1.3 + 4.7) - 0.5) / 255.0;
    gl_FragColor = vec4(col, 1.0);
}`;

class FullscreenPass {
    constructor(material) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.frustumCulled = false;
        this.scene = new THREE.Scene();
        this.scene.add(this.mesh);
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    render(renderer, target, material) {
        if (material) this.mesh.material = material;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.camera);
    }
}

export class Post {
    constructor(renderer, tier) {
        this.renderer = renderer;
        const hdr = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
        this.type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
        this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { type: this.type, samples: hdr ? tier.msaa : 0, depthBuffer: true });
        this.mips = [];
        this.levels = tier.bloomLevels;

        const mat = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
            vertexShader: fullscreenVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...extra,
        });
        this.down = mat(downsampleFragment, {
            tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
            uThreshold: { value: hdr ? 0.7 : 0.6 }, uKnee: { value: 0.45 }, uPrefilter: { value: true },
        });
        this.up = mat(upsampleFragment, {
            tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uWeight: { value: 1 },
        }, { blending: THREE.AdditiveBlending, transparent: true });
        this.composite = mat(compositeFragment, {
            tScene: { value: null }, tBloom: { value: null }, tFlare: { value: null }, tStreak: { value: null },
            uResolution: { value: new THREE.Vector2(1, 1) }, uStreakTexel: { value: new THREE.Vector2() },
            uTime: { value: 0 }, uExposure: { value: 1 }, uBloom: { value: 0.5 }, uFlare: { value: 0.35 },
            uStreak: { value: 0.12 }, uCA: { value: 1 }, uGrain: { value: 0.035 }, uVignette: { value: 0.55 },
            uDesaturate: { value: 0 }, uZoomBlur: { value: 0 }, uWarm: { value: 0 },
            uFlash: { value: 0 }, uZoomCenter: { value: new THREE.Vector2(0.5, 0.5) },
            uRipple: { value: new THREE.Vector4(0.5, 0.5, 0, 0) }, uRippleRefract: { value: 1 }, uRippleWidth: { value: 0.05 },
        });
        this.uniforms = this.composite.uniforms;
        this.pass = new FullscreenPass(this.composite);
        this.setTier(tier);
    }

    setTier(tier) {
        this.tier = tier;
        if (tier.bloomLevels !== this.levels || !this.mips.length) {
            this.levels = tier.bloomLevels;
            this.mips.forEach(m => m.dispose());
            this.mips = Array.from({ length: this.levels }, () => new THREE.WebGLRenderTarget(1, 1, {
                type: this.type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            }));
            if (this.width) this.setSize(this.width, this.height);
        }
        this.uniforms.uFlare.value = tier.flare ? 0.18 : 0;
        this.uniforms.uStreak.value = tier.streak ? 0.12 : 0;
        this.uniforms.uCA.value = tier.ca;
        this.uniforms.uGrain.value = tier.grain;
    }

    setSize(width, height) {
        this.width = width;
        this.height = height;
        this.sceneTarget.setSize(width, height);
        let w = width, h = height;
        for (const mip of this.mips) {
            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
            mip.setSize(w, h);
        }
        this.uniforms.uResolution.value.set(width, height);
    }

    render(scene, camera, time) {
        const r = this.renderer;
        r.setRenderTarget(this.sceneTarget);
        r.clear();
        r.render(scene, camera);

        // Bloom: downsample chain.
        let src = this.sceneTarget;
        this.mips.forEach((mip, i) => {
            this.down.uniforms.tSrc.value = src.texture;
            this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
            this.down.uniforms.uPrefilter.value = i === 0;
            this.pass.render(r, mip, this.down);
            src = mip;
        });
        // Low mips feed the flare and streak. Upsampling adds the even blurrier levels into
        // them, which only widens those effects.
        const flareMip = this.mips[Math.min(3, this.levels - 1)];
        const streakMip = this.mips[Math.min(2, this.levels - 1)];
        // Upsample and accumulate back into mip 0.
        r.autoClear = false;
        for (let i = this.levels - 1; i > 0; i--) {
            this.up.uniforms.tSrc.value = this.mips[i].texture;
            this.up.uniforms.uTexel.value.set(1 / this.mips[i].width, 1 / this.mips[i].height);
            // Wide levels are kept faint so glow stays local and dark areas stay dark.
            this.up.uniforms.uWeight.value = i >= 3 ? 0.55 : i === 2 ? 0.8 : 1.0;
            this.pass.render(r, this.mips[i - 1], this.up);
        }
        r.autoClear = true;

        const u = this.uniforms;
        u.tScene.value = this.sceneTarget.texture;
        u.tBloom.value = this.mips[0].texture;
        u.tFlare.value = flareMip.texture;
        u.tStreak.value = streakMip.texture;
        u.uStreakTexel.value.set(1 / streakMip.width, 1 / streakMip.height);
        u.uTime.value = time;
        this.pass.render(r, null, this.composite);
    }

    dispose() {
        this.sceneTarget.dispose();
        this.mips.forEach(m => m.dispose());
    }
}
