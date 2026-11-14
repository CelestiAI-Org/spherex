// SPHEREx Explorer sky scene: entry point.
// Builds the scene, runs the render loop, and exposes `scene` (also window.spherexScene),
// the integration surface for the UI and data code: flyTo, finish / showFrames, reset, onPick.
import * as THREE from "./scene/three.js";
import { createSky } from "./scene/sky.js";
import { createStars } from "./scene/stars.js";
import { createGalaxies } from "./scene/galaxies.js";
import { createNebulae } from "./scene/nebulae.js";
import { createBlackHole } from "./scene/blackhole.js";
import { createNoiseTexture } from "./scene/noise.js";
import { Post } from "./scene/post.js";
import { CameraRig } from "./scene/camera.js";
import { TIERS, readParams, detectTier, PerformanceGovernor } from "./scene/quality.js";
import { startFallback } from "./scene/fallback.js";
import { DEG, clamp01, damp, radec, sleep } from "./scene/util.js";

const container = document.getElementById("sky-scene");
if (!container) {
    throw new Error('Could not find the element with id "sky-scene".');
}

// Make the viewer a full-page background.
Object.assign(document.documentElement.style, { width: "100%", height: "100%", margin: "0" });
Object.assign(document.body.style, { width: "100%", height: "100%", margin: "0", overflow: "hidden", background: "#02030b" });
Object.assign(container.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", zIndex: "0", overflow: "hidden" });

// Opening shot: black hole low centre against open sky, Milky Way down the left, hero galaxy upper right.
const HOME = { ra: 240, dec: -15, fov: 60 };

const params = readParams();
const pickHandlers = new Set();

function createRenderer() {
    try {
        const probe = document.createElement("canvas").getContext("webgl2");
        if (!probe) return null;
        const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false });
        return renderer.capabilities.isWebGL2 ? renderer : null;
    } catch (error) {
        console.warn("WebGL unavailable, using the 2D fallback sky.", error);
        return null;
    }
}

const renderer = createRenderer();
export const scene = renderer ? createSpaceScene(renderer) : createFallbackScene();
window.spherexScene = scene;

function createFallbackScene() {
    startFallback(container);
    return {
        ready: Promise.resolve(),
        quality: "fallback",
        async flyTo(_target, { minDuration = 2.2 } = {}) { await sleep(minDuration * 1000); return true; },
        async finish() { return true; },
        async showFrames() { return true; },
        async reset() { return true; },
        onPick(fn) { pickHandlers.add(fn); return () => pickHandlers.delete(fn); },
        setQuality() {},
    };
}

function createSpaceScene(renderer) {
    renderer.autoClear = true;
    renderer.toneMapping = THREE.NoToneMapping;
    container.appendChild(renderer.domElement);
    const canvas = renderer.domElement;
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", cursor: "grab", touchAction: "none" });

    const detected = detectTier(renderer);
    let tier = TIERS[params.forced || detected.tier];
    let scale = 1;

    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(HOME.fov, innerWidth / innerHeight, 0.1, 8000);
    const shared = {
        uTime: { value: 0 },
        uPxScale: { value: 1 },
        uTwinkle: { value: 1 },
        uBhDir: { value: new THREE.Vector3(0, 0, -1) },
        uBhCull: { value: 2 },
    };
    const noise = createNoiseTexture(256);
    const sky = createSky(renderer, tier.cubeSize);
    world.background = sky.texture;
    world.backgroundIntensity = 1;

    const stars = createStars(shared);
    const galaxies = createGalaxies({ uniforms: shared, noise });
    const nebulae = createNebulae({ uniforms: shared, noise });
    const blackHole = createBlackHole({ skyTexture: sky.texture, noise });
    shared.uBhDir.value.copy(blackHole.position).normalize();
    shared.uBhCull.value = Math.cos(3.4 * DEG);
    world.add(blackHole.mesh, stars.group, galaxies.group, nebulae.group);

    const post = new Post(renderer, tier);
    const rig = new CameraRig(camera, canvas, { yaw: HOME.ra * DEG, pitch: HOME.dec * DEG, fov: HOME.fov });

    function applyTier(next) {
        tier = next;
        stars.setTier(tier);
        galaxies.setTier(tier);
        nebulae.setTier(tier);
        blackHole.setTier(tier);
        post.setTier(tier);
        resize();
    }
    function resize() {
        const ratio = Math.min(devicePixelRatio || 1, tier.pixelRatio) * scale;
        renderer.setPixelRatio(ratio);
        renderer.setSize(innerWidth, innerHeight, false);
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        post.setSize(size.x, size.y);
        shared.uPxScale.value = size.y / 1080;
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
    }
    addEventListener("resize", resize);

    const governor = new PerformanceGovernor({
        locked: Boolean(params.forced),
        onScale: value => { scale = value; resize(); },
        onTier: name => applyTier(TIERS[name]),
    });

    // --- FPS overlay: Shift+F toggles it, or start with ?fps in the URL.
    const hud = document.createElement("div");
    Object.assign(hud.style, {
        position: "fixed", top: "8px", right: "8px", zIndex: "50", padding: "4px 8px",
        font: "11px/1.4 ui-monospace, monospace", color: "#9fe8ff", background: "rgba(0,8,20,0.6)",
        border: "1px solid rgba(120,200,255,0.25)", borderRadius: "6px", pointerEvents: "none",
        display: params.fps ? "block" : "none", whiteSpace: "pre",
    });
    document.body.appendChild(hud);
    addEventListener("keydown", e => {
        if (e.shiftKey && (e.key === "F" || e.key === "f") && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) {
            hud.style.display = hud.style.display === "none" ? "block" : "none";
        }
    });

    // --- Scene state.
    const state = {
        exposure: 0,          // animated toward exposureTarget
        exposureTarget: 1.0,
        fade: 1, desaturate: 0,
        baked: false,
    };
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });

    applyTier(tier);

    let last = performance.now();
    let time = 0;
    let hudTimer = 0;
    function frame(now) {
        requestAnimationFrame(frame);
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        // Bake the sky one cube face per frame before showing anything.
        if (!state.baked) {
            state.baked = sky.bakeStep();
            if (!state.baked) return;
            resolveReady();
            rig.fov = rig.fovTarget = HOME.fov - 8;     // opening: slow pull back while fading in
            rig.animateTo({ fov: HOME.fov, duration: 6 });
        }

        time += dt;
        shared.uTime.value = time;
        rig.update(dt, time);
        galaxies.update(time);
        blackHole.update(time, camera, post.height);

        state.exposure = damp(state.exposure, state.exposureTarget, 0.9, dt);
        const u = post.uniforms;
        u.uExposure.value = state.exposure;
        u.uFade.value = state.fade;
        u.uDesaturate.value = state.desaturate;

        post.render(world, camera, time);
        governor.update(dt, tier.name);

        if (hud.style.display !== "none" && (hudTimer -= dt) <= 0) {
            hudTimer = 0.5;
            const size = renderer.getDrawingBufferSize(new THREE.Vector2());
            hud.textContent = `${governor.fps.toFixed(0)} fps  ${tier.name}${params.forced ? " (locked)" : ""}\n${size.x}×${size.y} @${scale.toFixed(2)}\n${detected.gpu.slice(0, 40)}`;
        }
    }
    requestAnimationFrame(frame);

    rig.onPick((x, y) => {
        pickHandlers.forEach(fn => fn({ x, y }));
    });

    // Tuning handle for development only: window.spherexScene.debug with ?debug in the URL.
    const debug = params.debug ? { post, blackHole, rig, state, world } : undefined;

    return {
        ready,
        debug,
        get quality() { return tier.name; },
        // Turn toward a sky position. target: { ra, dec } in degrees.
        async flyTo(target, { minDuration = 2.2 } = {}) {
            const turn = rig.animateTo({ yaw: target.ra * DEG, pitch: target.dec * DEG, fov: 38, duration: minDuration });
            await Promise.all([turn, sleep(minDuration * 1000)]);
            return true;
        },
        async finish() { return true; },
        async showFrames() { return this.finish(); },
        async reset() {
            await rig.animateTo({ yaw: HOME.ra * DEG, pitch: HOME.dec * DEG, fov: HOME.fov, duration: 2 });
            return true;
        },
        onPick(fn) { pickHandlers.add(fn); return () => pickHandlers.delete(fn); },
        setQuality(name) { if (TIERS[name]) { governor.locked = true; applyTier(TIERS[name]); } },
    };
}
