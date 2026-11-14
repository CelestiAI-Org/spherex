import * as THREE from "./three.js";
import { NOISE3 } from "./glsl.js";
import { DEG, clamp01, ease, rng } from "./util.js";

// Cinematic supernova intro (~25 s), played once per browser before the idle black hole shot.
//
//  0-5 s   a massive star (granulated surface, corona, slow flares); the camera drifts
//  5-10 s  instability: it swells, reddens, pulses faster and shudders
//  10-12 s core collapse: it shrinks and dims, a held beat
//  12-16 s supernova: a flash that ramps over ~300 ms, an expanding filamentary shell, ejecta
//  12-20 s the shockwave ripple refracts the view and pushes rocks and dust outward
//  18-25 s the remnant shrinks to a point, the black hole's lensing then its disk fade in, and
//          the camera glides out to the idle shot
//
// Comfort: a single flash ramping over >= 200 ms, pulses below 2 Hz, no strobing. With
// prefers-reduced-motion a gentle crossfade version plays (no flash, ripple, shake or camera move).
// Flags: ?intro=off never plays, ?intro=on plays on every load; otherwise once per browser.

const DURATION = 25;
const STORAGE_KEY = "spherex.introSeen.v1";
const STAR_RADIUS = 150;        // world units; the black hole sits at 1700

const CAPTIONS = [
    { from: 0.8, to: 4.6, text: "A massive star reaches the end of its life." },
    { from: 5.6, to: 9.6, text: "Its core can no longer hold." },
    { from: 12.9, to: 16.8, text: "A supernova outshines a whole galaxy for a few weeks." },
    { from: 19.6, to: 24.2, text: "What remains can be a black hole." },
];

const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = THREE.MathUtils.lerp;

// ---------- Shaders ----------
const starVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
}`;
const starFragment = /* glsl */ `
uniform float uTime, uTemp, uBright, uOctaves, uActivity;
varying vec3 vNormal;
varying vec3 vWorld;
${NOISE3}
vec3 starColor(float t) {
    // t: 0 deep red supergiant .. 1 hot blue-white
    vec3 red = vec3(1.0, 0.32, 0.1), orange = vec3(1.0, 0.62, 0.3), white = vec3(1.0, 0.93, 0.85), blue = vec3(0.75, 0.85, 1.0);
    return t < 0.35 ? mix(red, orange, t / 0.35) : t < 0.7 ? mix(orange, white, (t - 0.35) / 0.35) : mix(white, blue, (t - 0.7) / 0.3);
}
void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    float mu = max(dot(n, v), 0.0);
    // Slow rotation of the surface pattern.
    float a = uTime * 0.02;
    vec3 p = vec3(n.x * cos(a) - n.z * sin(a), n.y, n.x * sin(a) + n.z * cos(a));
    // Granulation: bright cells with dark lanes, plus larger supergranules and spots.
    float cells = fbm(p * 14.0 + vec3(0.0, uTime * 0.05, 0.0), int(uOctaves));
    float gran = smoothstep(0.32, 0.72, cells);
    float big = fbm(p * 3.5 - uTime * 0.01, 3);
    float spots = smoothstep(0.68, 0.8, big) * 0.25;
    float plage = smoothstep(0.55, 0.8, fbm(p * 5.0 + uTime * 0.04, 3)) * uActivity;
    // Limb darkening (quadratic law), redder toward the limb.
    float limb = 1.0 - 0.62 * (1.0 - mu) - 0.22 * (1.0 - mu) * (1.0 - mu);
    vec3 col = starColor(uTemp - (1.0 - mu) * 0.3) * limb * (0.78 + 0.32 * gran) * (1.0 - spots);
    col += starColor(uTemp + 0.2) * plage * 0.8;
    gl_FragColor = vec4(col * uBright, 1.0);
}`;

const billboardVertex = /* glsl */ `
varying vec2 vP;
void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// Corona + flares around the star; vP is in units of the star radius.
const coronaFragment = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime, uTemp, uBright, uFlares;
varying vec2 vP;
void main() {
    float r = length(vP);
    if (r < 0.98) discard;
    float ang = atan(vP.y, vP.x) / 6.2831853;
    float x = r - 1.0;
    float streamer = texture2D(uNoise, vec2(ang * 5.0, x * 0.35 - uTime * 0.012)).r;
    float glow = exp(-x * 4.0) * 0.5 + exp(-x * 14.0) * 1.0;
    glow *= 0.75 + 0.5 * streamer;
    // Flares: a few soft plumes lifting off the limb (angular mask x radial falloff), drifting slowly.
    float plumeMask = smoothstep(0.62, 0.85, texture2D(uNoise, vec2(ang * 2.0 + uTime * 0.003, 0.5)).g);
    float flare = plumeMask * exp(-x * 4.0) * (0.6 + 0.4 * streamer) * uFlares;
    vec3 warm = mix(vec3(1.0, 0.35, 0.1), vec3(1.0, 0.8, 0.6), uTemp);
    vec3 col = warm * (glow + flare) * uBright * 0.3;
    col *= smoothstep(3.0, 1.6, r);
    gl_FragColor = vec4(col, 1.0);
}`;
// Expanding supernova shell, vP in units of the current shell radius.
const shellFragment = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime, uAge, uAlpha, uSimple;
varying vec2 vP;
void main() {
    float r = length(vP);
    if (r > 1.25) discard;
    float ang = atan(vP.y, vP.x) / 6.2831853;
    // Filaments: ridged noise in polar coordinates, drawn radially outward.
    float fil = texture2D(uNoise, vec2(ang * 6.0, r * 0.6 - uAge * 0.05)).b;
    float knots = texture2D(uNoise, vec2(ang * 11.0 + 0.3, r * 1.4)).r;
    float edge = exp(-pow((r - 1.0) / (0.03 + 0.035 * knots), 2.0));
    float inner = smoothstep(1.0, 0.25, r) * 0.08;
    float strands = pow(fil, 2.5);
    float body = mix(edge * (0.15 + 2.2 * strands), edge * 0.6, uSimple) + inner * (0.3 + 1.5 * strands);
    // Hot to cool with age and toward the inside: blue-white -> gold -> red/magenta.
    vec3 hot = vec3(0.8, 0.88, 1.0), mid = vec3(1.0, 0.7, 0.35), cool = vec3(0.9, 0.25, 0.35);
    float age = clamp(uAge / 7.0, 0.0, 1.0);
    vec3 col = age < 0.4 ? mix(hot, mid, age / 0.4) : mix(mid, cool, (age - 0.4) / 0.6);
    col = mix(col, cool * vec3(0.8, 0.6, 1.2), smoothstep(0.9, 0.3, r) * 0.6);
    gl_FragColor = vec4(col * body * uAlpha, 1.0);
}`;
const glowFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uBright;
varying vec2 vP;
void main() {
    float r = length(vP);
    if (r > 1.0) discard;
    float g = exp(-r * r * 30.0) * 2.0 + exp(-r * 6.0) * 0.35;
    gl_FragColor = vec4(uColor * g * uBright * smoothstep(1.0, 0.6, r), 1.0);
}`;
const ejectaVertex = /* glsl */ `
attribute vec4 aEject;       // direction (xyz), speed
uniform float uProgress, uPxScale;
uniform vec3 uCentre;
varying float vFade;
varying float vHeat;
void main() {
    float travel = (1.0 - exp(-uProgress * 0.45)) * aEject.w;
    vec3 world = uCentre + aEject.xyz * travel;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(2.5 * uPxScale * (0.6 + aEject.w / 900.0), 1.5);
    vFade = smoothstep(0.0, 0.3, uProgress) * (1.0 - smoothstep(4.0, 9.0, uProgress));
    vHeat = clamp(1.0 - uProgress / 6.0, 0.0, 1.0);
}`;
const ejectaFragment = /* glsl */ `
varying float vFade;
varying float vHeat;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    vec3 col = mix(vec3(1.0, 0.4, 0.15), vec3(0.85, 0.9, 1.0), vHeat);
    gl_FragColor = vec4(col * exp(-r2 * 4.0) * vFade * 2.5, 1.0);
}`;

function billboard(fragmentShader, uniforms, size) {
    const material = new THREE.ShaderMaterial({
        vertexShader: billboardVertex, fragmentShader, uniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * 2, size * 2), material);
    mesh.frustumCulled = false;
    return mesh;
}

export function createIntro({ world, rig, state, post, blackHole, debris, flight, shared, noise, home, params }) {
    const centre = blackHole.position.clone();
    const reduced = params.reducedMotion;
    const search = new URLSearchParams(location.search);
    const flag = search.get("intro");

    // ---- Scene objects ----
    const group = new THREE.Group();
    group.visible = false;
    world.add(group);

    const starUniforms = {
        uTime: shared.uTime, uTemp: { value: 0.75 }, uBright: { value: 1.0 }, uOctaves: { value: 5 }, uActivity: { value: 0.3 },
    };
    const star = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.ShaderMaterial({
        vertexShader: starVertex, fragmentShader: starFragment, uniforms: starUniforms,
    }));
    star.position.copy(centre);
    star.renderOrder = 2;
    group.add(star);

    const coronaUniforms = { uNoise: { value: noise }, uTime: shared.uTime, uTemp: starUniforms.uTemp, uBright: { value: 1 }, uFlares: { value: 0.3 } };
    const corona = billboard(coronaFragment, coronaUniforms, 3);
    corona.position.copy(centre);
    group.add(corona);

    const shellUniforms = { uNoise: { value: noise }, uTime: shared.uTime, uAge: { value: 0 }, uAlpha: { value: 0 }, uSimple: { value: 0 } };
    const shell = billboard(shellFragment, shellUniforms, 1.25);
    shell.position.copy(centre);
    shell.visible = false;
    group.add(shell);

    const remnantUniforms = { uColor: { value: new THREE.Vector3(0.85, 0.9, 1.0) }, uBright: { value: 0 } };
    const remnant = billboard(glowFragment, remnantUniforms, 1);
    remnant.position.copy(centre);
    group.add(remnant);

    const EJECTA = 1600;
    const random = rng(2025);
    const eject = new Float32Array(EJECTA * 4);
    for (let i = 0; i < EJECTA; i++) {
        const y = random() * 2 - 1, t = random() * Math.PI * 2, s = Math.sqrt(1 - y * y);
        eject.set([s * Math.cos(t), y, s * Math.sin(t), 250 + Math.pow(random(), 0.6) * 650], i * 4);
    }
    const ejectaGeometry = new THREE.BufferGeometry();
    ejectaGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(EJECTA * 3), 3));
    ejectaGeometry.setAttribute("aEject", new THREE.BufferAttribute(eject, 4));
    const ejectaUniforms = { uProgress: { value: 0 }, uPxScale: shared.uPxScale, uCentre: { value: centre } };
    const ejecta = new THREE.Points(ejectaGeometry, new THREE.ShaderMaterial({
        vertexShader: ejectaVertex, fragmentShader: ejectaFragment, uniforms: ejectaUniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    ejecta.frustumCulled = false;
    ejecta.visible = false;
    group.add(ejecta);

    // ---- DOM: caption, skip button, replay entry ----
    const caption = document.createElement("p");
    caption.className = "intro-caption";
    caption.setAttribute("aria-live", "polite");
    document.body.appendChild(caption);
    const skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.className = "intro-skip";
    skipButton.textContent = "Skip intro";
    skipButton.hidden = true;
    document.body.appendChild(skipButton);
    const replayButton = document.createElement("button");
    replayButton.type = "button";
    replayButton.className = "intro-replay";
    replayButton.textContent = "Replay intro";
    document.getElementById("target-panel")?.appendChild(replayButton);

    // ---- State ----
    let active = false, t = 0, captionIndex = -1, cameraHanded = false, tier = null;
    const aim = { yaw: 0, pitch: 0 };
    const centreScreen = new THREE.Vector3();
    const toStar = new THREE.Vector3();
    const dustShock = new THREE.Vector3();
    let dustPassed = -1;

    function seen() { try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; } }
    function markSeen() { try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* private mode etc. */ } }
    const shouldPlay = flag === "on" || (flag !== "off" && !seen());

    function setCaption(text) {
        if (caption.dataset.text === (text || "")) return;
        caption.dataset.text = text || "";
        caption.classList.remove("is-on");
        if (text) {
            setTimeout(() => { if (caption.dataset.text === text) { caption.textContent = text; caption.classList.add("is-on"); } }, 450);
        }
    }

    function start() {
        active = true;
        t = 0;
        captionIndex = -1;
        cameraHanded = false;
        dustPassed = -1;
        group.visible = true;
        shell.visible = false;
        ejecta.visible = false;
        document.body.classList.add("in-intro");
        skipButton.hidden = false;
        rig.inputEnabled = false;
        if (rig.anim) { rig.anim.resolve(false); rig.anim = null; }
        rig.velocity.set(0, 0);
        debris.resetShock();
        blackHole.setFade(0, 0);
        // Aim at the star, slightly off-centre for composition.
        toStar.copy(centre).normalize();
        aim.yaw = Math.atan2(-toStar.z, toStar.x) + 3.5 * DEG;
        aim.pitch = Math.asin(toStar.y) + 1.5 * DEG;
        rig.yaw = aim.yaw;
        rig.pitch = aim.pitch;
        rig.fov = rig.fovTarget = reduced ? 40 : 30;
        state.exposure = 0;
        state.exposureTarget = 1;
        state.exposureRate = 1.2;
        update(0);
    }

    // Jump straight to the idle scene (Skip, Esc/Space, or any user action).
    function finish({ cut = true } = {}) {
        if (!active) return;
        active = false;
        group.visible = false;
        setCaption("");
        caption.classList.remove("is-on");
        skipButton.hidden = true;
        document.body.classList.remove("in-intro");
        blackHole.setFade(1, 1);
        post.uniforms.uRipple.value.w = 0;
        if (tier) post.setTier(tier);                      // restores flare and streak
        debris.setDustShock(dustShock.set(0, 0, 0));
        rig.shake = 0;
        rig.inputEnabled = true;
        markSeen();
        if (cut) {
            if (rig.anim) { rig.anim.resolve(false); rig.anim = null; }
            rig.yaw = home.ra * DEG;
            rig.pitch = home.dec * DEG;
            rig.fov = rig.fovTarget = home.fov;
            state.exposure = Math.min(state.exposure, 0.35);   // soft cut, never a jump in brightness
            state.exposureTarget = 1;
            state.exposureRate = 2.2;
        }
    }

    // Screen-space shock test for rocks: true once the ripple ring has passed their projection.
    let rippleRadius = 0, rippleOn = false;
    const rp = new THREE.Vector3();
    function shockTest(position) {
        if (!rippleOn) return null;
        rp.copy(position).project(rig.camera);
        if (rp.z > 1) return null;
        const aspect = innerWidth / innerHeight;
        const dx = ((rp.x * 0.5 + 0.5) - centreScreen.x) * aspect, dy = (rp.y * 0.5 + 0.5) - centreScreen.y;
        if (Math.hypot(dx, dy) > rippleRadius) return null;
        return position.clone().sub(centre).normalize();
    }

    function update(dt) {
        if (!active) return;
        t += dt;
        const u = post.uniforms;
        // A huge bright disc makes the pseudo lens flare and streak look wrong: off during the intro.
        u.uFlare.value = 0;
        u.uStreak.value = 0;

        // ---- Star: calm, then unstable, then collapse.
        const swell = smooth(5, 10, t);
        const collapse = ease.inCubic(clamp01((t - 10) / 1.6));
        const pulseRate = lerp(0.25, 1.6, swell);                       // Hz, always below 2
        const pulse = Math.sin(t * Math.PI * 2 * pulseRate) * lerp(0.004, 0.025, swell);
        const radius = STAR_RADIUS * (1 + 0.28 * swell + pulse) * (1 - 0.88 * collapse);
        star.scale.setScalar(radius);
        star.visible = corona.visible = t < 12.05;
        starUniforms.uTemp.value = lerp(0.9, 0.2, swell) + collapse * 0.5;
        starUniforms.uBright.value = (0.95 + 0.55 * swell + pulse * 8) * (1 - 0.75 * collapse);
        starUniforms.uActivity.value = lerp(0.3, 1.0, swell);
        coronaUniforms.uFlares.value = lerp(0.35, 1.3, swell) * (1 - collapse);
        coronaUniforms.uBright.value = (1 + 0.9 * swell) * (1 - collapse * 0.9);
        corona.scale.setScalar(radius);
        corona.quaternion.copy(rig.camera.quaternion);

        // ---- Supernova: one flash ramping over 300 ms, then a long, soft decay.
        const sn = t - 12;
        const flashUp = smooth(0, 0.3, sn);
        const flashDown = Math.exp(-Math.max(sn - 0.3, 0) / 0.7);
        const flash = sn > 0 ? flashUp * flashDown * (reduced ? 0.15 : 1.0) : 0;
        // The flash comes from the core (a bloom burst), plus only a slight overall lift.
        u.uFlash.value = Math.max(u.uFlash.value, flash * 0.12);

        shell.visible = sn > 0 && sn < 8.6;
        if (shell.visible) {
            const grow = 1 - Math.exp(-sn * 0.42);
            const shellR = STAR_RADIUS * (0.6 + (tier?.name === "low" ? 4.5 : 6.5) * grow);
            shell.scale.setScalar(shellR);
            shell.quaternion.copy(rig.camera.quaternion);
            shellUniforms.uAge.value = sn;
            shellUniforms.uAlpha.value = smooth(0, 0.4, sn) * (1 - smooth(4.5, 8.5, sn)) * 1.1;
            shellUniforms.uSimple.value = tier?.name === "low" ? 1 : 0;
        }
        ejecta.visible = sn > 0 && sn < 10 && !reduced;
        ejectaUniforms.uProgress.value = Math.max(sn, 0);

        // Remnant glow, then the core shrinks to a point as the black hole fades in.
        const remnantBright = sn > 0 ? smooth(0, 0.5, sn) * (0.9 * Math.exp(-sn / 4) + 0.45) * (1 - smooth(18.5, 21.5, t)) : 0;
        remnantUniforms.uBright.value = remnantBright + flash * 9;
        remnant.scale.setScalar(STAR_RADIUS * lerp(1.6, 0.35, smooth(16, 21, t)));
        remnant.quaternion.copy(rig.camera.quaternion);
        remnant.visible = remnantBright > 0.001;

        // ---- Black hole: lensing first, then the disk.
        blackHole.setFade(smooth(18.5, 21.5, t), smooth(20.5, 24.5, t));

        // ---- Ripple: screen-space ring from the star's projection.
        centreScreen.copy(centre).project(rig.camera);
        centreScreen.set(centreScreen.x * 0.5 + 0.5, centreScreen.y * 0.5 + 0.5, 0);
        const rip = t - 12.3;
        rippleOn = rip > 0 && rip < 8 && !reduced;
        if (rippleOn) {
            rippleRadius = 2.1 * (1 - Math.exp(-rip * 0.42)) + rip * 0.03;
            const strength = 0.022 * smooth(0, 0.6, rip) * (1 - smooth(4.5, 8, rip));
            u.uRipple.value.set(centreScreen.x, centreScreen.y, rippleRadius, strength);
            u.uRippleWidth.value = 0.045 + rip * 0.01;
            u.uRippleRefract.value = tier?.name === "low" ? 0 : 1;
            // Dust: once the ring has swept past the screen centre, the field drifts outward and settles.
            const toCentre = Math.hypot((0.5 - centreScreen.x) * innerWidth / innerHeight, 0.5 - centreScreen.y);
            if (dustPassed < 0 && rippleRadius > toCentre) dustPassed = t;
        } else {
            u.uRipple.value.w = 0;
        }
        if (dustPassed > 0) {
            const k = 1 - Math.exp(-(t - dustPassed) * 0.9);
            dustShock.copy(rig.camera.position).sub(centre).normalize().multiplyScalar(14 * k);
            debris.setDustShock(dustShock);
        }

        // ---- Camera: slow drift and push-in, shudder during instability, pull out at the
        // explosion, then glide to the idle shot.
        if (!cameraHanded) {
            if (reduced) {
                rig.yaw = aim.yaw;
                rig.pitch = aim.pitch;
            } else {
                // Shudder: a smooth, small oscillation (not random jitter) while the star destabilises.
                const shudder = smooth(6, 10, t) * (1 - smooth(10.2, 10.8, t)) * 0.12 * DEG;
                rig.yaw = aim.yaw + 1.2 * DEG * Math.sin(t * 0.12) + shudder * Math.sin(t * 31.0) * Math.sin(t * 2.3);
                rig.pitch = aim.pitch + 0.6 * DEG * Math.sin(t * 0.09 + 1) + shudder * Math.sin(t * 27.0 + 1.0) * Math.cos(t * 1.7);
                const push = lerp(30, 27, smooth(0, 10, t));
                const pull = lerp(0, 18, ease.outCubic(clamp01((t - 12.2) / 4.5)));
                rig.fov = rig.fovTarget = push + pull;
            }
            if (t >= 18) {
                cameraHanded = true;
                rig.shake = 0;
                rig.animateTo({ yaw: home.ra * DEG, pitch: home.dec * DEG, fov: home.fov, duration: reduced ? 5 : 7, easing: ease.inOutCubic });
            }
        }

        // ---- Exposure: the held beat at collapse dims the frame.
        state.exposureTarget = 1 - 0.45 * smooth(10, 11.3, t) * (1 - smooth(11.8, 12.4, t));
        state.exposureRate = 2.5;

        // ---- Captions.
        const current = CAPTIONS.findIndex(c => t >= c.from && t < c.to);
        if (current !== captionIndex) {
            captionIndex = current;
            setCaption(current >= 0 ? CAPTIONS[current].text : "");
        }

        if (t >= DURATION) finish({ cut: false });
    }

    // ---- Controls ----
    skipButton.addEventListener("click", () => finish());
    addEventListener("keydown", e => {
        if (!active) return;
        const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
        if (e.key === "Escape" || (e.key === " " && !typing)) {
            e.preventDefault();
            finish();
        }
    });
    // Any menu action or search skips immediately (capture phase, before the form handlers).
    const menu = document.querySelector(".target-menu");
    menu?.addEventListener("pointerdown", e => { if (active && e.target !== replayButton) finish(); }, true);
    menu?.addEventListener("focusin", e => { if (active && e.target !== replayButton) finish(); }, true);
    document.getElementById("target-form")?.addEventListener("submit", () => finish(), true);
    replayButton.addEventListener("click", async () => {
        if (flight.phase !== "idle") await flight.reset();
        start();
    });

    return {
        get active() { return active; },
        shouldPlay,
        start,
        skip: () => finish(),
        update,
        shockTest: shockTest,
        setTier(next) {
            tier = next;
            starUniforms.uOctaves.value = next.name === "low" ? 3 : next.name === "medium" ? 4 : 5;
            ejectaGeometry.setDrawRange(0, next.name === "low" ? 500 : next.name === "medium" ? 1100 : EJECTA);
        },
    };
}
