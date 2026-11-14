// Quality tiers. Geometry is generated once at the highest count needed and lower tiers
// draw a prefix of it (drawRange), so stepping down at runtime never rebuilds anything.

export const TIERS = {
    low: {
        name: "low", pixelRatio: 1, cubeSize: 1024, msaa: 0, bloomLevels: 4,
        stars: 0.45, heroStars: 0.6, nebulaLayers: 4, galaxyPoints: 0.35,
        bhSteps: 48, asteroids: 60, dust: 0.4,
        flare: false, streak: false, grain: 0.03, ca: 0.0,
    },
    medium: {
        name: "medium", pixelRatio: 1.25, cubeSize: 1536, msaa: 0, bloomLevels: 5,
        stars: 0.75, heroStars: 1, nebulaLayers: 6, galaxyPoints: 0.7,
        bhSteps: 80, asteroids: 140, dust: 0.75,
        flare: true, streak: true, grain: 0.035, ca: 0.6,
    },
    high: {
        name: "high", pixelRatio: 2, cubeSize: 2048, msaa: 4, bloomLevels: 6,
        stars: 1, heroStars: 1, nebulaLayers: 8, galaxyPoints: 1,
        bhSteps: 128, asteroids: 220, dust: 1,
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
    };
}

// Guess a starting tier from the GPU name. Integrated and mobile GPUs start at medium/low;
// the runtime monitor steps down further if the frame rate suffers.
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
    if (/rtx|gtx 1[06-9]|radeon rx|radeon pro|apple m[1-9] (pro|max|ultra)|arc a7/.test(g)) return { tier: "high", gpu };
    return { tier: "medium", gpu };
}

// Watches frame times and asks for a cheaper setting when the scene can't hold ~50 fps.
// First it lowers the render resolution, then it drops a tier. It never steps back up,
// so the scene doesn't oscillate during a presentation.
export class PerformanceGovernor {
    constructor({ onScale, onTier, locked }) {
        this.onScale = onScale;
        this.onTier = onTier;
        this.locked = locked;
        this.samples = [];
        this.scale = 1;
        this.warmup = 3;      // seconds ignored after start and after each change
        this.badWindows = 0;
        this.fps = 60;
    }
    reset(warmup = 2.5) {
        this.samples.length = 0;
        this.warmup = warmup;
        this.badWindows = 0;
    }
    update(dt, currentTier) {
        if (dt > 0.25) return;            // tab switch or breakpoint, not a real frame
        this.samples.push(dt);
        if (this.samples.length >= 60) {
            const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
            this.fps = 1 / avg;
            this.samples.length = 0;
            if (this.warmup > 0 || this.locked) return;
            this.badWindows = this.fps < 48 ? this.badWindows + 1 : 0;
            if (this.badWindows >= 2) {
                this.badWindows = 0;
                if (this.scale > 0.71) {
                    this.scale = Math.round((this.scale - 0.15) * 100) / 100;
                    this.onScale(this.scale);
                } else {
                    const index = ORDER.indexOf(currentTier);
                    if (index > 0) {
                        this.scale = 1;
                        this.onTier(ORDER[index - 1]);
                        this.onScale(this.scale);
                    }
                }
                this.reset();
            }
        }
        this.warmup -= dt;
    }
}
