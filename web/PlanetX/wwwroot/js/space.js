// SPHEREx Explorer sky scene: entry point.
// Builds the scene, runs the render loop, and exposes `scene` (also window.spherexScene),
// the integration surface for the UI and data code:
//
//   scene.ready                      Promise, resolves once the sky is baked and visible.
//   scene.flyTo(target, { minDuration = 3.2 })
//        target: { ra, dec } in degrees, or a Promise of one (e.g. a name lookup).
//        Starts the warm zoom and resolves after minDuration seconds; the warp keeps
//        cruising until finish() so slow API calls are hidden.
//   scene.finish() / scene.showFrames()
//        Decelerate, arrival flash, dim the sky for the data panels. Resolves on arrival.
//   scene.reset()                    Fade back to the opening view.
//   scene.onPick(fn)                 fn({ key, name, ra, dec }) when a target beacon is clicked.
//                                    Returns an unsubscribe function.
//   scene.quality / scene.setQuality("low" | "medium" | "high")
//
// Typical use:
//   await Promise.all([scene.flyTo(target), api.getFrames(key)]);
//   await scene.finish();   // then show the data view
import * as THREE from "./scene/three.js";
import { createSky } from "./scene/sky.js";
import { createStars } from "./scene/stars.js";
import { createGalaxies } from "./scene/galaxies.js";
import { createNebulae } from "./scene/nebulae.js";
import { createBlackHole } from "./scene/blackhole.js";
import { createDebris } from "./scene/asteroids.js";
import { createWarpStreaks, createBeacons } from "./scene/warp.js";
import { createTargetLayer } from "./scene/targets.js";
import { Flight } from "./scene/flight.js";
import { wireDemo } from "./scene/wiring.js";
import { createNoiseTexture } from "./scene/noise.js";
import { Post } from "./scene/post.js";
import { CameraRig } from "./scene/camera.js";
import { TIERS, readParams, detectTier, PerformanceGovernor } from "./scene/quality.js";
import { startFallback } from "./scene/fallback.js";
import { DEG, damp, radec, sleep } from "./scene/util.js";

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
if (new URLSearchParams(location.search).get("wiring") !== "off") wireDemo(scene);

function createFallbackScene() {
    startFallback(container);
    return {
        ready: Promise.resolve(),
        quality: "fallback",
        async flyTo(target, { minDuration = 3.2 } = {}) { await Promise.all([target, sleep(minDuration * 1000)]); return true; },
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
    let dataMode = false;
    let lost = false;

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
    const debris = createDebris({ uniforms: shared, lightDir: blackHole.position.clone().normalize(), home: radec(HOME.ra, HOME.dec) });
    const streaks = createWarpStreaks();
    const beacons = createBeacons(shared);
    world.add(blackHole.mesh, stars.group, galaxies.group, nebulae.group, debris.group, beacons.object, streaks.object);

    const post = new Post(renderer, tier);
    const rig = new CameraRig(camera, canvas, { yaw: HOME.ra * DEG, pitch: HOME.dec * DEG, fov: HOME.fov });
    const targets = createTargetLayer({ beacons, camera });

    function applyTier(next) {
        tier = next;
        stars.setTier(tier);
        galaxies.setTier(tier);
        nebulae.setTier(tier);
        blackHole.setTier(tier);
        debris.setTier(tier);
        post.setTier(tier);
        resize();
    }
    function resize() {
        // Behind the data panels the sky renders at 80 % resolution to leave GPU time for the UI.
        const ratio = Math.min(devicePixelRatio || 1, tier.pixelRatio) * scale * (dataMode ? 0.8 : 1);
        renderer.setPixelRatio(ratio);
        renderer.setSize(innerWidth, innerHeight, false);
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        post.setSize(size.x, size.y);
        shared.uPxScale.value = size.y / 1080;
        camera.aspect = innerWidth / innerHeight;
        rig.fovMul = camera.aspect < 1 ? Math.min(1.5, Math.pow(1 / camera.aspect, 0.45)) : 1;
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
        exposure: 0,          // animated toward exposureTarget at exposureRate
        exposureTarget: 1.0,
        exposureRate: 0.9,
        desaturate: 0,
        desaturateTarget: 0,
        baked: false,
    };
    const flight = new Flight({ rig, state, post, streaks, targets, home: HOME });
    flight.reducedMotion = params.reducedMotion;
    if (params.reducedMotion) rig.driftSpeed *= 0.4;

    // If the GPU drops the context (driver reset, too many tabs), swap to the 2D sky.
    canvas.addEventListener("webglcontextlost", event => {
        event.preventDefault();
        lost = true;
        canvas.remove();
        hud.remove();
        startFallback(container);
    });
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });

    applyTier(tier);

    let last = performance.now();
    let time = 0;
    let hudTimer = 0;
    function frame(now) {
        if (lost) return;
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
        flight.update(dt);
        if ((flight.phase === "data") !== dataMode) {
            dataMode = flight.phase === "data";
            resize();
        }
        galaxies.update(time);
        blackHole.update(time, camera, post.height);
        debris.update(time, flight.speed);
        targets.update(flight.labelsVisible);

        state.exposure = damp(state.exposure, state.exposureTarget, state.exposureRate, dt);
        state.desaturate = damp(state.desaturate, state.desaturateTarget, 1.5, dt);
        const u = post.uniforms;
        u.uExposure.value = state.exposure;
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

    // Picking and hover feedback on the target beacons.
    rig.onPick((x, y) => {
        if (!flight.labelsVisible) return;
        const target = targets.pick(x, y);
        if (target) pickHandlers.forEach(fn => fn(target));
    });
    canvas.addEventListener("pointermove", e => {
        if (e.buttons) return;
        const over = flight.labelsVisible && targets.hover(e.clientX, e.clientY);
        canvas.style.cursor = over ? "pointer" : "grab";
    });

    // Tuning handle for development only: window.spherexScene.debug with ?debug in the URL.
    const debug = params.debug ? { post, blackHole, rig, state, world, flight } : undefined;

    return {
        ready,
        debug,
        get quality() { return tier.name; },
        flyTo: (target, options) => flight.flyTo(target, options),
        finish: () => flight.finish(),
        showFrames: () => flight.finish(),
        reset: () => flight.reset(),
        onPick(fn) { pickHandlers.add(fn); return () => pickHandlers.delete(fn); },
        setQuality(name) { if (TIERS[name]) { governor.locked = true; applyTier(TIERS[name]); } },
    };
}
