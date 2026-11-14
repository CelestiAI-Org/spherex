// Sound for the sky scene, synthesised live with the Web Audio API. No samples, no music files.
//
// Layers:
//   intro  drone under the star (slowly opening filter), heartbeat and rising tones while it
//          destabilises, a sub-bass implosion and a held near-silence at core collapse, a boom
//          with a noise burst and falling low-pass plus a shimmer for the shell, and a whoosh
//          that pans across the stereo field with the shockwave.
//   idle   a dark, spacious pad with a faint shimmer, quiet enough to talk over.
//
// Browsers only allow audio after a user gesture, so the AudioContext is created on the first
// click / key press / touch and everything fades in from silence. The intro drives the timeline
// through sync(t); joining late simply picks up the continuous layers at that point.
//
// Safety: master gain about -12 dB, a compressor acting as a limiter on the master bus, no
// attack shorter than 30 ms, fade-outs on skip and mute, suspended while the tab is hidden, and
// every temporary node is stopped and disconnected when it ends.
// Flags: ?sound=off disables sound. The on/off button's choice is remembered in localStorage.

const PREF_KEY = "spherex.sound";
const MASTER = 0.25;                    // about -12 dB, applied after the limiter
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createSound({ reduced = false, debug = false } = {}) {
    const disabled = new URLSearchParams(location.search).get("sound") === "off"
        || !(window.AudioContext || window.webkitAudioContext);
    let wanted = !disabled && readPref();
    let ctx = null, master = null, bus = null, analyser = null, noiseBuffer = null;
    let mode = "idle";                  // "intro" | "idle"
    let low = false;
    let intro = null;                   // continuous intro layer
    let pad = null;                     // idle pad layer
    const oneShots = new Set();
    const fired = {};
    let nextBeat = 5.2, lastSync = -1, muteTimer = 0;

    function readPref() { try { return localStorage.getItem(PREF_KEY) !== "off"; } catch { return true; } }
    function writePref() { try { localStorage.setItem(PREF_KEY, wanted ? "on" : "off"); } catch { /* private mode */ } }
    const level = () => MASTER * (reduced ? 0.3 : 1);

    // ---- UI ----
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sound-toggle";
    button.hidden = disabled;
    document.body.appendChild(button);
    function label() {
        button.textContent = !wanted ? "Sound off" : ctx ? "Sound on" : "Click for sound";
        button.setAttribute("aria-pressed", String(wanted));
        button.classList.toggle("is-off", !wanted);
    }
    label();

    // ---- Helpers ----
    const now = () => ctx.currentTime;
    function glide(param, value, seconds = 0.3) {
        param.cancelScheduledValues(now());
        param.setTargetAtTime(value, now(), Math.max(seconds, 0.01) / 3);
    }
    function osc(type, frequency, destination) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = frequency;
        o.connect(destination);
        o.start();
        return o;
    }
    function gain(value, destination) {
        const g = ctx.createGain();
        g.gain.value = value;
        if (destination) g.connect(destination);
        return g;
    }
    function filter(type, frequency, q, destination) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = frequency;
        f.Q.value = q;
        if (destination) f.connect(destination);
        return f;
    }
    function noise(destination) {
        const n = ctx.createBufferSource();
        n.buffer = noiseBuffer;
        n.loop = true;
        n.connect(destination);
        n.start();
        return n;
    }
    // A feedback delay as a cheap sense of space. Returns the input node.
    function space(destination, time, feedback, nodes) {
        const input = gain(1, destination);
        const delay = ctx.createDelay(1);
        delay.delayTime.value = time;
        const fb = gain(feedback);
        const damp = filter("lowpass", 2400, 0.5);
        input.connect(delay);
        delay.connect(damp);
        damp.connect(fb);
        fb.connect(delay);
        damp.connect(destination);
        nodes.push(input, delay, fb, damp);
        return input;
    }
    function dispose(layer) {
        if (!layer) return;
        for (const s of layer.sources) { try { s.stop(); } catch { /* already stopped */ } }
        for (const n of [...layer.sources, ...layer.nodes]) { try { n.disconnect(); } catch { /* gone */ } }
    }
    // Temporary sounds: fade and stop themselves, and can be cut short by skip().
    function oneShot(duration, build) {
        const out = gain(1, bus);
        const shot = { out, sources: [], nodes: [out] };
        build(shot, now());
        oneShots.add(shot);
        shot.timer = setTimeout(() => { dispose(shot); oneShots.delete(shot); }, (duration + 0.3) * 1000);
        return shot;
    }
    function cutOneShots() {
        for (const shot of oneShots) {
            clearTimeout(shot.timer);
            glide(shot.out.gain, 0, 0.3);
            setTimeout(() => dispose(shot), 500);
        }
        oneShots.clear();
    }

    // ---- Context ----
    function init() {
        if (ctx || disabled) return;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const limiter = ctx.createDynamicsCompressor();
        // bus -> limiter -> master volume -> speakers. The master volume sits after the limiter,
        // so the limiter's make-up gain can never push the output above the master level.
        limiter.threshold.value = -10;
        limiter.knee.value = 6;
        limiter.ratio.value = 14;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.3;
        master = gain(0, ctx.destination);
        limiter.connect(master);
        bus = gain(0.5, limiter);
        if (debug) {
            analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            master.connect(analyser);
        }
        noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        // Fade in from silence: no jump or pop.
        master.gain.setValueAtTime(0, now());
        master.gain.linearRampToValueAtTime(level(), now() + 2);
        if (mode === "intro") buildIntro(); else startPad(3);
        label();
    }
    function unlock() {
        if (!wanted) return;
        if (!ctx) init();
        else if (ctx.state === "suspended" && !document.hidden) ctx.resume();
    }
    for (const type of ["pointerdown", "keydown", "touchstart"]) addEventListener(type, unlock, { capture: true, passive: true });
    document.addEventListener("visibilitychange", () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend();
        else if (wanted) ctx.resume();
    });
    button.addEventListener("click", () => {
        wanted = !wanted;
        writePref();
        clearTimeout(muteTimer);
        if (wanted) {
            if (!ctx) init();
            else { ctx.resume(); glide(master.gain, level(), 0.8); }
        } else if (ctx) {
            glide(master.gain, 0, 0.4);
            muteTimer = setTimeout(() => { if (!wanted) ctx.suspend(); }, 600);
        }
        label();
    });

    // ---- Idle pad ----
    function startPad(fadeSeconds) {
        if (!ctx) return;
        if (!pad) {
            pad = { sources: [], nodes: [] };
            pad.out = gain(0, bus);
            const tone = filter("lowpass", 520, 0.6, pad.out);
            const room = space(pad.out, 0.43, 0.5, pad.nodes);
            tone.connect(room);
            pad.nodes.push(pad.out, tone);
            // An open low chord (A, E, A, C, E); each voice breathes at its own slow rate.
            const voices = low ? [55, 82.41, 110] : [55, 82.41, 110, 130.81, 164.81];
            voices.forEach((f, i) => {
                const g = gain(0.07, tone);
                const lfo = osc("sine", 0.03 + i * 0.017, gain(0.045, g.gain));
                pad.sources.push(osc(i % 2 ? "triangle" : "sine", f * (1 + (i - 2) * 0.0015), g), lfo);
                pad.nodes.push(g);
            });
            // Subtle shimmer far above.
            if (!low) {
                [1760, 2637].forEach((f, i) => {
                    const g = gain(0.0035, room);
                    const lfo = osc("sine", 0.05 + i * 0.03, gain(0.003, g.gain));
                    pad.sources.push(osc("sine", f, g), lfo);
                    pad.nodes.push(g);
                });
            }
        }
        glide(pad.out.gain, 0.34, fadeSeconds);
    }

    // ---- Intro: continuous layer ----
    function buildIntro() {
        if (!ctx || intro) return;
        intro = { sources: [], nodes: [] };
        intro.droneGain = gain(0, bus);
        intro.droneFilter = filter("lowpass", 110, 2.2, intro.droneGain);
        intro.sources.push(osc("sawtooth", 55, intro.droneFilter), osc("sine", 27.5, gain(0.5, intro.droneGain)));
        if (!low) intro.sources.push(osc("sawtooth", 55.4, intro.droneFilter), osc("sawtooth", 82.2, gain(0.4, intro.droneFilter)));
        intro.sources.push(osc("sine", 0.07, gain(30, intro.droneFilter.frequency)));
        intro.tensionGain = gain(0, bus);
        const tone = filter("lowpass", 1100, 0.7, intro.tensionGain);
        intro.tensionA = osc("triangle", 110, tone);
        intro.tensionB = osc("triangle", 155.6, tone);
        intro.sources.push(intro.tensionA, intro.tensionB);
        intro.nodes.push(intro.droneGain, intro.droneFilter, intro.tensionGain, tone);
    }
    function endIntroLayer(fade) {
        if (!intro) return;
        const layer = intro;
        intro = null;
        glide(layer.droneGain.gain, 0, fade);
        glide(layer.tensionGain.gain, 0, fade);
        setTimeout(() => dispose(layer), (fade + 0.5) * 1000);
    }

    // ---- Intro: one-shots ----
    function heartbeat(strength) {
        oneShot(0.6, (shot, t0) => {
            for (const [offset, amount] of [[0, 1], [0.15, 0.7]]) {
                const g = gain(0, shot.out);
                const o = ctx.createOscillator();
                o.frequency.setValueAtTime(62, t0 + offset);
                o.frequency.exponentialRampToValueAtTime(36, t0 + offset + 0.2);
                g.gain.setValueAtTime(0, t0 + offset);
                g.gain.linearRampToValueAtTime(0.42 * strength * amount, t0 + offset + 0.03);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.3);
                o.connect(g);
                o.start(t0 + offset);
                o.stop(t0 + offset + 0.35);
                shot.sources.push(o);
                shot.nodes.push(g);
            }
        });
    }
    function implosion() {
        oneShot(2, (shot, t0) => {
            // A falling sub tone that swells and is then sucked away.
            const g = gain(0, shot.out);
            const o = ctx.createOscillator();
            o.frequency.setValueAtTime(120, t0);
            o.frequency.exponentialRampToValueAtTime(27, t0 + 1.5);
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(0.38, t0 + 1.25);
            g.gain.linearRampToValueAtTime(0, t0 + 1.55);
            o.connect(g);
            o.start(t0);
            o.stop(t0 + 1.7);
            // Air rushing inward.
            const ng = gain(0, shot.out);
            const band = filter("bandpass", 2200, 1.5, ng);
            band.frequency.setValueAtTime(2200, t0);
            band.frequency.exponentialRampToValueAtTime(140, t0 + 1.45);
            ng.gain.setValueAtTime(0, t0);
            ng.gain.linearRampToValueAtTime(0.1, t0 + 1.3);
            ng.gain.linearRampToValueAtTime(0, t0 + 1.5);
            shot.sources.push(o, noise(band));
            shot.nodes.push(g, ng, band);
        });
    }
    function boom() {
        const scale = reduced ? 0.4 : 1;
        oneShot(9, (shot, t0) => {
            // Sub drop.
            const sg = gain(0, shot.out);
            const sub = ctx.createOscillator();
            sub.frequency.setValueAtTime(72, t0);
            sub.frequency.exponentialRampToValueAtTime(24, t0 + 2.6);
            sg.gain.setValueAtTime(0, t0);
            sg.gain.linearRampToValueAtTime(0.85 * scale, t0 + 0.08);
            sg.gain.exponentialRampToValueAtTime(0.001, t0 + 5);
            sub.connect(sg);
            sub.start(t0);
            sub.stop(t0 + 5.2);
            // Body.
            const bg = gain(0, shot.out);
            const body = ctx.createOscillator();
            body.type = "triangle";
            body.frequency.setValueAtTime(115, t0);
            body.frequency.exponentialRampToValueAtTime(38, t0 + 1.1);
            bg.gain.setValueAtTime(0, t0);
            bg.gain.linearRampToValueAtTime(0.35 * scale, t0 + 0.06);
            bg.gain.exponentialRampToValueAtTime(0.001, t0 + 1.8);
            body.connect(bg);
            body.start(t0);
            body.stop(t0 + 2);
            // Noise burst through a falling low-pass.
            const ng = gain(0, shot.out);
            const lp = filter("lowpass", 7000, 0.8, ng);
            lp.frequency.setValueAtTime(7000, t0);
            lp.frequency.exponentialRampToValueAtTime(170, t0 + 3.6);
            ng.gain.setValueAtTime(0, t0);
            ng.gain.linearRampToValueAtTime(0.42 * scale, t0 + 0.05);
            ng.gain.exponentialRampToValueAtTime(0.001, t0 + 4.5);
            shot.sources.push(sub, body, noise(lp));
            shot.nodes.push(sg, bg, ng, lp);
            // Shimmer for the shell: high partials that drift in and out, with echo.
            const sh = gain(0, shot.out);
            const room = space(sh, 0.31, 0.5, shot.nodes);
            sh.gain.setValueAtTime(0, t0 + 0.4);
            sh.gain.linearRampToValueAtTime(1, t0 + 2.2);
            sh.gain.setValueAtTime(1, t0 + 5.5);
            sh.gain.linearRampToValueAtTime(0, t0 + 8.5);
            const partials = low ? [1318.5, 1975.5, 2637] : [1318.5, 1760, 1975.5, 2637, 3520];
            partials.forEach((f, i) => {
                const g = gain(0, room);
                const curve = new Float32Array(9);
                for (let k = 0; k < 9; k++) curve[k] = (0.3 + 0.7 * Math.random()) * 0.011 / (1 + i * 0.25);
                g.gain.setValueCurveAtTime(curve, t0 + 0.4, 8.2);
                const o = ctx.createOscillator();
                o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.004);
                o.connect(g);
                o.start(t0 + 0.4);
                o.stop(t0 + 8.8);
                shot.sources.push(o);
                shot.nodes.push(g);
            });
            shot.nodes.push(sh);
        });
    }
    // Pans from the star's side of the screen to the far side as the ring crosses.
    function whoosh(fromPan, toPan, seconds) {
        oneShot(seconds + 0.6, (shot, t0) => {
            const g = gain(0, shot.out);
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : gain(1);
            pan.connect(g);
            if (pan.pan) {
                pan.pan.setValueAtTime(fromPan, t0);
                pan.pan.linearRampToValueAtTime(toPan, t0 + seconds);
            }
            const band = filter("bandpass", 1700, 1.1, pan);
            band.frequency.setValueAtTime(1700, t0);
            band.frequency.exponentialRampToValueAtTime(260, t0 + seconds);
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(0.26, t0 + 0.6);
            g.gain.linearRampToValueAtTime(0.12, t0 + seconds * 0.7);
            g.gain.linearRampToValueAtTime(0, t0 + seconds + 0.4);
            shot.sources.push(noise(band));
            shot.nodes.push(g, pan, band);
        });
    }

    // Fire a one-shot when the timeline crosses its time (not when joining late).
    function cue(name, t, at, fn) {
        if (fired[name] || t < at) return;
        fired[name] = true;
        if (t - at < 0.6) fn();
    }

    return {
        get enabled() { return wanted; },
        setTier(isLow) { low = isLow; },
        startIntro() {
            mode = "intro";
            lastSync = -1;
            nextBeat = 5.2;
            for (const key of Object.keys(fired)) delete fired[key];
            if (!ctx) return;
            cutOneShots();
            if (pad) glide(pad.out.gain, 0, 2);
            buildIntro();
        },
        // Called every frame by the intro with its time in seconds.
        sync(t) {
            if (!ctx || mode !== "intro" || ctx.state !== "running") return;
            if (!reduced) {
                if (t >= nextBeat && t < 10.1) {
                    const tension = smooth(5, 10, t);
                    heartbeat(0.35 + 0.65 * tension);
                    nextBeat = t + 1 / (1 + 0.7 * tension);         // 1 to 1.7 beats a second
                }
                cue("implosion", t, 10, implosion);
                cue("whoosh", t, 12.15, () => whoosh(0.35, -0.85, 3.2));
            }
            cue("boom", t, 12, boom);
            cue("pad", t, 17.5, () => startPad(6));
            if (t - lastSync < 0.1 || !intro) return;
            lastSync = t;
            const drone = t < 10 ? 0.15 * smooth(0, 3.5, t) * (1 + 0.6 * smooth(5, 10, t))
                : t < 12 ? 0.24 * (1 - smooth(10, 11.4, t))            // held near-silence before the boom
                : 0.1 * smooth(12, 13.5, t) * (1 - smooth(17, 22, t));
            glide(intro.droneGain.gain, drone, 0.25);
            const open = smooth(0, 10, t);
            glide(intro.droneFilter.frequency, t < 12 ? 110 + 720 * open * open : 260, 0.3);
            const rise = smooth(5, 10, t);
            glide(intro.tensionGain.gain, reduced ? 0 : 0.07 * rise * (1 - smooth(10, 10.4, t)), 0.2);
            glide(intro.tensionA.frequency, 110 * (1 + 0.5 * rise), 0.3);
            glide(intro.tensionB.frequency, 155.6 * (1 + 0.5 * rise), 0.3);
        },
        // Intro finished or skipped: fade its sound out and settle into the pad.
        endIntro() {
            if (mode !== "intro") return;
            mode = "idle";
            if (!ctx) return;
            endIntroLayer(0.5);
            cutOneShots();
            startPad(3);
        },
        // Development helper (?debug): current peak level after the limiter, 0..1.
        peak() {
            if (!analyser) return 0;
            const data = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v));
            return peak;
        },
        get state() { return ctx ? ctx.state : "none"; },
        get nodeCount() { return oneShots.size; },
    };
}
