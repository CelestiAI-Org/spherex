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
//  17-20 s the gas thins, the camera pushes in and the core shrinks to a point and winks out
//  20-28 s light starts to bend, the photon ring ignites, the disk lights from its inner edge
//          outward, and the camera pulls back and glides to the idle shot
//
// Comfort: a single flash ramping over >= 200 ms, pulses below 2 Hz, no strobing. With
// prefers-reduced-motion a gentle crossfade version plays (no flash, ripple, shake or camera move).
// It plays on every page load, after a "Click to begin" screen. Flags: ?intro=off disables it;
// ?gate=0 starts it without waiting for the click.
// Sound comes from scene/audio.js, driven by this timeline through sound.sync(t).

const DURATION = 28;
const STAR_RADIUS = 150;        // world units; the black hole sits at 1700

// The story lines: when each caption appears (seconds into the intro) and the optional recorded
// voice file that goes with it. Change the times or the text here.
export const LINES = [
    { at: 0.5, file: "line1.mp3", text: "A massive star reaches the end of its life." },
    { at: 6, file: "line2.mp3", text: "Its core can no longer hold." },
    { at: 12.5, file: "line3.mp3", text: "A supernova outshines a whole galaxy for a few weeks." },
    { at: 19, file: "line4.mp3", text: "Gravity crushes what is left of the core." },
    { at: 23, file: "line5.mp3", text: "What remains can be a black hole." },
];
// Voice files are optional: wwwroot/audio/voice/line1.mp3 ... A missing file is skipped and its
// caption still shows. level is the voice volume, duckTo how far the music and effects dip under
// it (0.35 is about -9 dB), gap the pause between lines if one runs into the next.
export const VOICE = { folder: "audio/voice/", level: 1.0, duckTo: 0.35, gap: 0.3 };
const CAPTION_HOLD = 4.4;       // seconds a caption stays up (shorter if the next line is due)

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
    float cells = fbm(p * 19.0 + vec3(0.0, uTime * 0.05, 0.0), int(uOctaves));
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
    float streamer = textureLod(uNoise, vec2(ang * 5.0, x * 0.35 - uTime * 0.012), 1.0).r;
    float glow = exp(-x * 4.0) * 0.5 + exp(-x * 14.0) * 1.0;
    glow *= 0.75 + 0.5 * streamer;
    // Flares: a few soft plumes lifting off the limb (angular mask x radial falloff), drifting slowly.
    float plumeMask = smoothstep(0.62, 0.85, textureLod(uNoise, vec2(ang * 2.0 + uTime * 0.003, 0.5), 1.0).g);
    float flare = plumeMask * exp(-x * 4.0) * (0.6 + 0.4 * streamer) * uFlares;
    vec3 warm = mix(vec3(1.0, 0.35, 0.1), vec3(1.0, 0.8, 0.6), uTemp);
    vec3 col = warm * (glow + flare) * uBright * 0.3;
    col *= smoothstep(3.0, 1.6, r);
    gl_FragColor = vec4(col, 1.0);
}`;
// Expanding supernova shell, vP in units of the current shell radius: a thin shock front with a
// lumpy outline, a zone of filaments and knots behind it, and faint wisps inside.
const shellFragment = /* glsl */ `
uniform sampler2D uNoise;
uniform float uAge, uAlpha, uSimple;
varying vec2 vP;
float n(vec2 uv, int channel) {
    vec4 t = textureLod(uNoise, uv, 1.0);        // fixed mip: no seam where the angle wraps
    return channel == 0 ? t.r : channel == 1 ? t.g : t.b;
}
void main() {
    float r0 = length(vP);
    if (r0 > 1.3) discard;
    float ang = atan(vP.y, vP.x) / 6.2831853;
    float lump = n(vec2(ang * 2.0, 0.37), 0) - 0.5;
    float fine = n(vec2(ang * 9.0, 0.71), 1) - 0.5;
    float r = r0 / (1.0 + 0.11 * lump + 0.035 * fine);
    float front = exp(-pow((r - 1.0) / 0.011, 2.0)) + 0.35 * exp(-pow((r - 1.0) / 0.035, 2.0));
    float zone = smoothstep(0.6, 0.96, r) * (1.0 - smoothstep(0.985, 1.02, r));
    float f1 = n(vec2(ang * 7.0, r * 1.1 - uAge * 0.03), 2);
    float f2 = n(vec2(ang * 17.0 + 0.4, r * 2.3), 2);
    float fil = pow(f1, 2.2) * 1.7 + pow(f2, 3.0) * 1.3;
    float knots = smoothstep(0.62, 0.9, n(vec2(ang * 13.0, r * 3.0 + 0.2), 0));
    float wisp = n(vec2(ang * 4.0 + r * 0.3, r * 0.9 - uAge * 0.02), 1);
    float interior = smoothstep(1.0, 0.15, r) * smoothstep(0.05, 0.3, r) * wisp * wisp * 0.2;
    float age = clamp(uAge / 6.0, 0.0, 1.0);
    vec3 frontCol = mix(vec3(0.68, 0.84, 1.0), vec3(1.0, 0.74, 0.5), age);
    vec3 filCol = mix(vec3(1.0, 0.84, 0.58), vec3(1.0, 0.36, 0.2), clamp(smoothstep(1.0, 0.62, r) * 0.75 + age * 0.4, 0.0, 1.0));
    // Patches of blue-green gas among the gold and red, as in real remnants.
    float hue = n(vec2(ang * 3.0 + 0.1, r * 0.8), 0);
    filCol = mix(filCol, vec3(0.3, 0.85, 0.8), smoothstep(0.52, 0.78, hue) * 0.65 * (0.35 + 0.65 * age));
    vec3 inCol = mix(vec3(0.95, 0.3, 0.42), vec3(0.42, 0.26, 0.9), smoothstep(0.75, 0.2, r));
    vec3 col = frontCol * front * 1.3
             + filCol * zone * mix(fil + knots * 0.7, 0.45, uSimple)
             + inCol * interior * (1.0 - uSimple);
    gl_FragColor = vec4(col * uAlpha, 1.0);
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
    float h = fract(aEject.w * 0.0137);
    gl_PointSize = max((1.2 + 3.2 * h * h) * uPxScale, 1.5);
    vFade = smoothstep(0.0, 0.3, uProgress) * (1.0 - smoothstep(4.0, 9.0, uProgress)) * (0.25 + 1.3 * h * h);
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

export function createIntro({ world, rig, state, post, blackHole, debris, flight, shared, noise, home, params, sound }) {
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

    sound?.setVoice(LINES, VOICE, DURATION);
    const shouldPlay = flag !== "off";                  // plays on every load unless ?intro=off
    // A "Click to begin" screen holds the first frame, so one click starts picture and sound
    // together (browsers only allow audio after a gesture). ?gate=0 skips it.
    let gatePending = search.get("gate") !== "0" && shouldPlay;
    let held = false;
    const gate = document.createElement("button");
    gate.type = "button";
    gate.className = "intro-gate";
    gate.hidden = true;
    gate.innerHTML = "<span>SPHEREx Explorer</span><strong>Click to begin</strong><em>Best with sound</em>";
    document.body.appendChild(gate);
    function begin() {
        if (!held) return;
        held = false;
        gate.hidden = true;
        document.body.classList.remove("is-gated");
        skipButton.hidden = false;
        sound?.startIntro();
    }
    gate.addEventListener("click", begin);

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
        held = gatePending;
        gatePending = false;
        gate.hidden = !held;
        document.body.classList.toggle("is-gated", held);
        skipButton.hidden = held;
        if (!held) sound?.startIntro();
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
        held = false;
        gate.hidden = true;
        document.body.classList.remove("is-gated");
        sound?.endIntro(cut);
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
        if (!held) t += dt;
        sound?.sync(t);
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
        starUniforms.uBright.value = (1.3 + 0.5 * swell + pulse * 8) * (1 - 0.75 * collapse);
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

        shell.visible = sn > 0 && sn < 10.6;
        if (shell.visible) {
            const grow = 1 - Math.exp(-sn * 0.42);
            const shellR = STAR_RADIUS * (0.6 + (tier?.name === "low" ? 4.5 : 6.5) * grow);
            shell.scale.setScalar(shellR);
            shell.quaternion.copy(rig.camera.quaternion);
            shellUniforms.uAge.value = sn;
            shellUniforms.uAlpha.value = smooth(0, 0.4, sn) * (1 - smooth(4.5, 10.5, sn)) * 0.8;
            shellUniforms.uSimple.value = tier?.name === "low" ? 1 : 0;
        }
        ejecta.visible = sn > 0 && sn < 10 && !reduced;
        ejectaUniforms.uProgress.value = Math.max(sn, 0);

        // Remnant glow, then the core shrinks to a point as the black hole fades in.
        // The core shrinks to a point, gathers its last light, and winks out as the hole forms.
        const lastLight = 2.2 * smooth(19.2, 19.8, t) * (1 - smooth(19.9, 20.5, t));
        const remnantBright = sn > 0 ? (smooth(0, 0.5, sn) * (0.9 * Math.exp(-sn / 4) + 0.45) + lastLight) * (1 - smooth(19.9, 20.5, t)) : 0;
        remnantUniforms.uBright.value = remnantBright + flash * 6;
        remnant.scale.setScalar(STAR_RADIUS * lerp(1.6, 0.1, smooth(15, 19.8, t)));
        remnant.quaternion.copy(rig.camera.quaternion);
        remnant.visible = remnantBright > 0.001;

        // ---- Black hole: lensing first, then the disk.
        // Light starts to bend (20-23 s), the photon ring ignites (21.5 s), then the disk lights
        // from its inner edge outward (22-27 s).
        const ringIgnite = 1 + 6 * smooth(21.3, 22.3, t) * (1 - smooth(23.2, 25.5, t));
        blackHole.setFade(smooth(20, 23, t), smooth(22, 27, t), ringIgnite);

        // ---- Ripple: screen-space ring from the star's projection.
        centreScreen.copy(centre).project(rig.camera);
        centreScreen.set(centreScreen.x * 0.5 + 0.5, centreScreen.y * 0.5 + 0.5, 0);
        const rip = t - 12.15;
        rippleOn = rip > 0 && rip < 8 && !reduced;
        if (rippleOn) {
            rippleRadius = 0.42 * Math.pow(rip, 0.85);       // crosses the frame in about 3 s, ahead of the shell
            const strength = 0.034 * smooth(0, 0.4, rip) * (1 - smooth(3.5, 6.5, rip));
            u.uRipple.value.set(centreScreen.x, centreScreen.y, rippleRadius, strength);
            u.uRippleWidth.value = 0.04 + rip * 0.012;
            u.uRippleRefract.value = tier?.name === "low" ? 0 : 1;
            // Dust: once the ring has swept past the screen centre, the field drifts outward and settles.
            const toCentre = Math.hypot((0.5 - centreScreen.x) * innerWidth / innerHeight, 0.5 - centreScreen.y);
            if (dustPassed < 0 && rippleRadius > toCentre) dustPassed = t;
        } else if (t > 10.3 && t < 11.9 && !reduced) {
            // Core collapse: light is pulled inward, a ring closing on the star.
            u.uRipple.value.set(centreScreen.x, centreScreen.y, 0.02 + 0.55 * (1 - smooth(10.3, 11.9, t)),
                -0.02 * smooth(10.3, 10.8, t) * (1 - smooth(11.5, 11.9, t)));
            u.uRippleWidth.value = 0.07;
            u.uRippleRefract.value = tier?.name === "low" ? 0 : 1;
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
                // Lens: slow push-in on the star, a tighter push as it collapses, a pull back with the
                // blast, then a slow push-in again on the dying core.
                let fov = lerp(30, 27, smooth(0, 10, t));
                fov -= 2.5 * ease.inCubic(clamp01((t - 10) / 2));
                fov += 21.5 * ease.outCubic(clamp01((t - 12.1) / 5));
                fov -= 6 * smooth(16.5, 20.5, t);
                rig.fov = rig.fovTarget = fov;
            }
            if (t >= 20.5) {
                // Hand over: pull back and glide to the idle shot while the disk ignites.
                cameraHanded = true;
                rig.shake = 0;
                rig.animateTo({ yaw: home.ra * DEG, pitch: home.dec * DEG, fov: home.fov, duration: 7, easing: ease.inOutCubic });
            }
        }

        // ---- Exposure: the held beat at collapse dims the frame.
        state.exposureTarget = (1 - 0.45 * smooth(10, 11.3, t) * (1 - smooth(11.8, 12.4, t)))
            * (1 - 0.22 * smooth(19.9, 20.5, t) * (1 - smooth(21.3, 23, t)));       // a breath of dark as the core winks out
        state.exposureRate = 2.5;

        // ---- Captions.
        let current = -1;
        LINES.forEach((line, i) => {
            const until = Math.min(line.at + CAPTION_HOLD, (LINES[i + 1]?.at ?? Infinity) - 0.5);
            if (t >= line.at + 0.3 && t < until) current = i;
        });
        const speaking = sound?.voiceLine ?? -1;          // a caption stays up while its line is spoken
        if (speaking >= 0) current = speaking;
        if (current !== captionIndex) {
            captionIndex = current;
            setCaption(current >= 0 ? LINES[current].text : "");
        }

        if (t >= DURATION) finish({ cut: false });
    }

    // ---- Controls ----
    skipButton.addEventListener("click", () => finish());
    addEventListener("keydown", e => {
        if (!active) return;
        const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
        if (held && (e.key === " " || e.key === "Enter")) {
            e.preventDefault();
            begin();
        } else if (e.key === "Escape" || (e.key === " " && !typing)) {
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
