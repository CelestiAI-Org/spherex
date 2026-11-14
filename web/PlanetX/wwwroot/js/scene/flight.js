import { DEG, damp, ease, sleep } from "./util.js";

// The "warm zoom": a cinematic flight toward a target's sky position while data loads.
//   flyTo(target)  align on the target, then accelerate into a warm-tinted warp and cruise.
//                  Resolves once the minimum flight time has passed (the cruise continues).
//   finish()       waits for that minimum, decelerates, flashes on arrival and settles
//                  into a dimmed "data mode" behind the panels. Resolves on arrival.
//   reset()        fades out, returns home and pulls back into the idle sky.
// A newer call cancels an older one (each call takes a token).

const MAX_TRAVEL = 900;   // world units; keeps the camera inside the star shells

export class Flight {
    constructor({ rig, state, post, streaks, targets, home }) {
        Object.assign(this, { rig, state, post, streaks, targets, home });
        this.phase = "idle";
        this.speed = 0;
        this.speedTarget = 0;
        this.flash = 0;
        this.token = 0;
        this.travelled = 0;
        this.minDone = Promise.resolve();
    }

    setBodyState(name) {
        document.body.classList.toggle("is-flying", name === "flying");
        document.body.classList.toggle("in-data", name === "data");
    }

    async flyTo(target, { minDuration = 3.2 } = {}) {
        const token = ++this.token;
        const { rig, state } = this;
        rig.inputEnabled = false;
        this.setBodyState("flying");
        state.exposureTarget = 1;
        state.exposureRate = 1.5;
        state.desaturateTarget = 0;
        this.minDone = sleep(Math.max(minDuration, 1.5) * 1000);

        let t = target;
        if (t && typeof t.then === "function") {
            // Coordinates not known yet (e.g. a name lookup): spool up straight ahead.
            this.phase = "warp";
            this.speedTarget = 0.4;
            try {
                t = await t;
            } catch (error) {
                if (token === this.token) await this.reset();
                throw error;
            }
            if (token !== this.token) return false;
        }
        if (t && Number.isFinite(t.ra) && Number.isFinite(t.dec)) {
            this.targets.setActive(t);
            this.phase = "align";
            await rig.animateTo({
                yaw: t.ra * DEG, pitch: t.dec * DEG, fov: 66,
                duration: this.speed > 0.2 ? 1.8 : 1.3, easing: ease.inOutCubic,
            });
            if (token !== this.token) return false;
        }
        this.phase = "warp";
        this.speedTarget = 1;
        // However long the turn took, give the full warp at least 1.4 s on screen.
        this.minDone = Promise.all([this.minDone, sleep(1400)]);
        await this.waitMin();
        return token === this.token;
    }

    // Resolves once the current minimum flight time has passed, even if flyTo extends it.
    async waitMin() {
        let current;
        do {
            current = this.minDone;
            await current;
        } while (current !== this.minDone);
    }

    async finish() {
        const token = this.token;
        await this.waitMin();
        if (token !== this.token) return false;
        const { rig, state } = this;
        if (this.phase === "warp" || this.phase === "align") {
            this.phase = "arrive";
            this.speedTarget = 0;
            rig.animateTo({ fov: 34, duration: 1.5, easing: ease.outCubic });
            await sleep(950);
            if (token !== this.token) return false;
            this.flash = 1;
        }
        this.phase = "data";
        state.exposureTarget = 0.62;
        state.exposureRate = 1.2;
        state.desaturateTarget = 0.22;
        rig.inputEnabled = true;
        this.setBodyState("data");
        return true;
    }

    async reset() {
        const token = ++this.token;
        const { rig, state, home } = this;
        this.phase = "return";
        this.speedTarget = 0;
        rig.inputEnabled = false;
        this.setBodyState("flying");
        state.exposureTarget = 0;
        state.exposureRate = 7;
        await sleep(520);
        if (token !== this.token) return false;

        // Cut while dark: back to the opening position, slightly zoomed in.
        this.speed = 0;
        this.travelled = 0;
        rig.travel.set(0, 0, 0);
        rig.velocity.set(0, 0);
        if (rig.anim) {
            rig.anim.resolve(false);    // let any awaiting flyTo settle
            rig.anim = null;
        }
        rig.yaw = home.ra * DEG;
        rig.pitch = home.dec * DEG;
        rig.fov = rig.fovTarget = home.fov - 14;
        this.targets.setActive(null);
        state.exposureTarget = 1;
        state.exposureRate = 1.6;
        state.desaturateTarget = 0;
        this.setBodyState("idle");
        this.phase = "idle";
        await rig.animateTo({ fov: home.fov, duration: 2.8, easing: ease.outCubic });
        if (token === this.token) rig.inputEnabled = true;
        return token === this.token;
    }

    update(dt) {
        const { rig, post } = this;
        const rising = this.speedTarget > this.speed;
        this.speed = damp(this.speed, this.speedTarget, rising ? 1.4 : 2.8, dt);
        if (this.speed < 1e-3) this.speed = 0;

        // Real forward motion (stars and dust rush past), capped so we stay in the star shells.
        const step = this.speed * 110 * dt;
        if (step > 0 && this.travelled < MAX_TRAVEL) {
            rig.travel.addScaledVector(rig.forward(), step);
            this.travelled += step;
        }
        if (this.phase === "warp" && !rig.anim) rig.fovTarget = 64 + this.speed * 12;

        this.streaks.update(dt, this.speed);
        rig.shake = this.reducedMotion ? 0 : this.speed * this.speed * 0.06;
        this.flash = Math.max(0, this.flash - dt * 1.6);
        const u = post.uniforms;
        u.uZoomBlur.value = this.speed * (this.reducedMotion ? 0.35 : 0.9);
        u.uWarm.value = this.speed * 0.32 + this.flash * 0.25;
        u.uFlash.value = this.flash * this.flash * 1.4;
    }

    get labelsVisible() {
        return this.phase === "idle";
    }
}
