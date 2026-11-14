// Quality tiers. Geometry is generated once at the highest count needed and lower tiers
// draw a prefix of it (drawRange), so stepping down at runtime never rebuilds anything.
// Black hole: bhScale is the resolution of its offscreen ray-traced buffer relative to the
// screen (the governor may lower it to bhScaleMin), bhSteps the RK4 steps per ray, and
// bhOctaves the noise octaves in the disk turbulence.

export const TIERS = {
    low: {
        name: "low", pixelRatio: 0.85, cubeSize: 1024, msaa: 0, bloomLevels: 4,
        stars: 0.45, heroStars: 0.6, nebulaLayers: 4, galaxyPoints: 0.35,
        bhSteps: 44, bhOctaves: 2, bhScale: 0.5, bhScaleMin: 0.5, asteroids: 60, dust: 0.4,
        flare: false, streak: false, grain: 0.03, ca: 0.0,
    },
    medium: {
        name: "medium", pixelRatio: 1, cubeSize: 1536, msaa: 0, bloomLevels: 5,
        stars: 0.75, heroStars: 1, nebulaLayers: 6, galaxyPoints: 0.7,
        bhSteps: 64, bhOctaves: 3, bhScale: 0.6, bhScaleMin: 0.5, asteroids: 140, dust: 0.75,
        flare: true, streak: true, grain: 0.035, ca: 0.6,
    },
    high: {
        name: "high", pixelRatio: 1.5, cubeSize: 2048, msaa: 4, bloomLevels: 6,
        stars: 1, heroStars: 1, nebulaLayers: 8, galaxyPoints: 1,
        bhSteps: 110, bhOctaves: 4, bhScale: 0.85, bhScaleMin: 0.6, asteroids: 220, dust: 1,
        flare: true, streak: true, grain: 0.035, ca: 1.0,
    },
};
export const ORDER = ["low", "medium", "high"];

export function readParams() {
    const params = new URLSearchParams(location.search);
    const q = (params.get("quality") || "").toLowerCase();
    return {
        forced: TIERS[q] ? q : null,
        fps: params.has("fps"),
        debug: params.has("debug"),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
}

// Starting tier from the GPU name: medium by default, high only for clearly strong discrete
// GPUs, low for software renderers and phones. The governor steps down further if needed.
export function detectTier(renderer) {
    const gl = renderer.getContext();
    let gpu = "";
    try {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
    } catch { /* some browsers hide this */ }
    const g = gpu.toLowerCase();
    const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent);
    if (mobile || /swiftshader|llvmpipe|software|mali|adreno|powervr/.test(g)) return { tier: "low", gpu };
    if (/rtx [2-5]0[6-9]0|rtx a[2-6]000|radeon rx [6-9][7-9]\d\d|apple m[1-9] (max|ultra)/.test(g)) return { tier: "high", gpu };
    return { tier: "medium", gpu };
}

// Watches the frame rate. When it stays below `threshold` fps for `sustain` seconds it asks the
// scene for one step cheaper (onDegrade decides what that means: black hole resolution first,
// then a tier, then overall resolution). It never steps back up, so a presentation doesn't
// oscillate, and it waits a moment after each change before judging again.
export class PerformanceGovernor {
    constructor({ onDegrade, locked = false, threshold = 45, sustain = 3 }) {
        this.onDegrade = onDegrade;
        this.locked = locked;
        this.threshold = threshold;
        this.sustain = sustain;
        this.fps = 60;
        this.lastAction = "";
        this.frames = 0;
        this.elapsed = 0;
        this.slowFor = 0;
        this.warmup = 4;          // seconds ignored at start (sky bake, shader compile)
    }
    update(dt) {
        if (dt > 0.25) return;    // tab switch or breakpoint, not a real frame
        this.frames++;
        this.elapsed += dt;
        if (this.elapsed < 0.5) return;
        this.fps = this.frames / this.elapsed;
        const window = this.elapsed;
        this.frames = 0;
        this.elapsed = 0;
        if (this.warmup > 0) {
            this.warmup -= window;
            return;
        }
        if (this.locked) return;
        this.slowFor = this.fps < this.threshold ? this.slowFor + window : 0;
        if (this.slowFor >= this.sustain) {
            this.slowFor = 0;
            this.warmup = 2;
            const action = this.onDegrade();
            if (action) this.lastAction = action;
        }
    }
}
