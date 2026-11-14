import * as THREE from "./three.js";
import { damp, ease } from "./util.js";

// Cinematic camera: grab the sky to look (with inertia), slow idle drift, a gentle "breathing"
// translation so near stars parallax against far ones, a hint of pointer parallax, and wheel
// zoom. yaw/pitch are the RA/Dec (radians) of the view direction, so aiming at a target is
// simply animateTo({ yaw: ra, pitch: dec }).

const TAU = Math.PI * 2;
const MAX_PITCH = 1.45;

export class CameraRig {
    constructor(camera, element, { yaw = 0, pitch = 0, fov = 60 } = {}) {
        this.camera = camera;
        this.element = element;
        this.yaw = yaw;
        this.pitch = pitch;
        this.fov = fov;
        this.fovTarget = fov;
        this.fovMul = 1;                        // >1 on portrait screens so the composition fits
        this.velocity = new THREE.Vector2();
        this.look = new THREE.Vector2();
        this.pointer = new THREE.Vector2();
        this.travel = new THREE.Vector3();      // extra translation used by flights
        this.shake = 0;
        this.idle = 0;
        this.inputEnabled = true;
        // Idle sway: the view glides very slowly left and right (about ±5° over 2.5 minutes)
        // instead of drifting off, so the black hole stays in frame while it moves.
        this.swayAmplitude = 5 * Math.PI / 180;
        this.swayPeriod = 150;
        this.swayTime = 0;
        this.anim = null;
        this.pickHandlers = new Set();
        this._forward = new THREE.Vector3();
        this._target = new THREE.Vector3();
        this._dragAnchor = null;
        this._dragPointer = new THREE.Vector2();
        this._dragRay = new THREE.Vector3();
        this._roll = 0;
        this.bind();
    }

    bind() {
        const el = this.element;
        let dragging = false, pointerId = null, lastT = 0, downX = 0, downY = 0, downT = 0;
        el.addEventListener("pointerdown", e => {
            if (e.button !== 0 || dragging) return;
            dragging = true;
            pointerId = e.pointerId;
            downX = e.clientX;
            downY = e.clientY;
            this.setPointer(e);
            if (this.inputEnabled) {
                if (this.anim) { this.anim.resolve(false); this.anim = null; }
                // Capture the actual rendered ray, including pointer lean and camera roll.
                this._dragAnchor = new THREE.Vector3(this.pointer.x, this.pointer.y, 0.5)
                    .applyMatrix4(this.camera.projectionMatrixInverse)
                    .normalize().applyQuaternion(this.camera.quaternion);
                this._dragPointer.copy(this.pointer);
            }
            lastT = downT = performance.now();
            this.velocity.set(0, 0);
            this.idle = 0;
            el.style.cursor = "grabbing";
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener("pointermove", e => {
            if (dragging && e.pointerId !== pointerId) return;
            this.setPointer(e);
            if (!dragging) return;
            this.idle = 0;
            if (!this.inputEnabled || !this._dragAnchor) return;
            const now = performance.now();
            const dt = Math.max((now - lastT) / 1000, 1 / 240);
            const yaw = this.yaw, pitch = this.pitch;
            this._dragPointer.copy(this.pointer);
            this.followDrag();
            // Smoothed angular velocity for the release fling.
            this.velocity.lerp(new THREE.Vector2((this.yaw - yaw) / dt, (this.pitch - pitch) / dt), 0.4);
            lastT = now;
        });
        const end = e => {
            if (!dragging || e.pointerId !== pointerId) return;
            dragging = false;
            this._dragAnchor = null;
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
            pointerId = null;
            el.style.cursor = "grab";
            if (e.type !== "pointerup" || performance.now() - lastT > 80) this.velocity.set(0, 0);
            const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
            if (e.type === "pointerup" && moved < 6 && performance.now() - downT < 400) {
                this.pickHandlers.forEach(fn => fn(e.clientX, e.clientY));
            }
        };
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
        el.addEventListener("lostpointercapture", end);
        el.addEventListener("wheel", e => {
            if (!this.inputEnabled) return;
            e.preventDefault();
            this.idle = 0;
            this.fovTarget = THREE.MathUtils.clamp(this.fovTarget * Math.exp(e.deltaY * 0.0012), 22, 75);
        }, { passive: false });
        this.dragging = () => dragging;
    }

    setPointer(e) {
        const rect = this.element.getBoundingClientRect();
        this.pointer.set(
            (e.clientX - rect.left) / rect.width * 2 - 1,
            1 - (e.clientY - rect.top) / rect.height * 2,
        );
    }

    followDrag() {
        if (!this._dragAnchor || !this.inputEnabled) return;
        const tan = Math.tan(Math.min(this.fov * this.fovMul, 100) * Math.PI / 360);
        const ray = this._dragRay.set(
            this._dragPointer.x * tan * this.camera.aspect,
            this._dragPointer.y * tan, -1,
        ).normalize();
        // Undo the fixed screen roll before solving the upright camera's yaw and pitch.
        const c = Math.cos(this._roll), s = Math.sin(this._roll), x = ray.x;
        ray.x = c * x - s * ray.y;
        ray.y = s * x + c * ray.y;
        const anchor = this._dragAnchor;
        const alpha = Math.atan2(ray.y, -ray.z);
        const elevation = Math.asin(THREE.MathUtils.clamp(anchor.y / Math.hypot(ray.y, ray.z), -1, 1));
        const current = this.pitch + this.look.y;
        const nearest = angle => current + Math.atan2(Math.sin(angle - current), Math.cos(angle - current));
        const p1 = nearest(elevation - alpha), p2 = nearest(Math.PI - elevation - alpha);
        const pitch = Math.abs(p1 - current) <= Math.abs(p2 - current) ? p1 : p2;
        this.pitch = THREE.MathUtils.clamp(pitch - this.look.y, -MAX_PITCH, MAX_PITCH);
        const effectivePitch = this.pitch + this.look.y;
        const forward = -ray.y * Math.sin(effectivePitch) - ray.z * Math.cos(effectivePitch);
        const yaw = Math.atan2(ray.x, forward) - Math.atan2(anchor.z, anchor.x) - this.look.x;
        this.yaw += Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    }

    onPick(fn) {
        this.pickHandlers.add(fn);
        return () => this.pickHandlers.delete(fn);
    }

    // Smoothly turn (and optionally zoom) to a direction. Resolves when finished.
    animateTo({ yaw = this.yaw, pitch = this.pitch, fov = this.fovTarget, duration = 1.6, easing = ease.inOutCubic }) {
        if (this.anim) this.anim.resolve(false);
        let dy = (yaw - this.yaw) % TAU;
        if (dy > Math.PI) dy -= TAU;
        if (dy < -Math.PI) dy += TAU;
        return new Promise(resolve => {
            this.anim = {
                from: { yaw: this.yaw, pitch: this.pitch, fov: this.fovTarget },
                to: { yaw: this.yaw + dy, pitch: THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH), fov },
                t: 0, duration: Math.max(duration, 0.01), easing, resolve,
            };
            this.velocity.set(0, 0);
        });
    }

    forward(out = this._forward) {
        const cp = Math.cos(this.pitch);
        return out.set(cp * Math.cos(this.yaw), Math.sin(this.pitch), -cp * Math.sin(this.yaw));
    }

    update(dt, time) {
        const a = this.anim;
        if (a) {
            a.t = Math.min(1, a.t + dt / a.duration);
            const k = a.easing(a.t);
            this.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * k;
            this.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k;
            this.fovTarget = this.fov = a.from.fov + (a.to.fov - a.from.fov) * k;
            if (a.t >= 1) {
                this.anim = null;
                a.resolve(true);
            }
        } else if (!this.dragging()) {
            // Release fling, then a slow drift once the user leaves it alone.
            this.yaw += this.velocity.x * dt;
            this.pitch = THREE.MathUtils.clamp(this.pitch + this.velocity.y * dt, -MAX_PITCH, MAX_PITCH);
            this.velocity.multiplyScalar(Math.exp(-3.2 * dt));
            this.idle += dt;
            const drift = THREE.MathUtils.smoothstep(this.idle, 5, 10);
            this.swayTime += dt * drift;
            const w = TAU / this.swayPeriod;
            this.yaw += this.swayAmplitude * w * Math.cos(this.swayTime * w) * drift * dt;
        }
        this.fov = damp(this.fov, this.fovTarget, 6, dt);

        // Pointer parallax: the view leans a fraction of a degree toward the cursor.
        if (!this._dragAnchor) {
            const lean = this.dragging() || a ? 0 : 1;
            this.look.x = damp(this.look.x, -this.pointer.x * 0.010 * lean, 2.5, dt);
            this.look.y = damp(this.look.y, this.pointer.y * 0.007 * lean, 2.5, dt);
            this._roll = damp(this._roll, Math.sin(time * 0.031) * 0.006, 2.5, dt);
        }
        // Re-solve every frame so zooming while dragging keeps the same sky anchor.
        this.followDrag();

        const cp = Math.cos(this.pitch + this.look.y);
        const yaw = this.yaw + this.look.x;
        const dir = this._target.set(cp * Math.cos(yaw), Math.sin(this.pitch + this.look.y), -cp * Math.sin(yaw));

        // Breathing: slow Lissajous translation of a few units gives real parallax.
        const cam = this.camera;
        cam.position.set(
            Math.sin(time * 0.051) * 2.2 + Math.sin(time * 0.017) * 1.5,
            Math.sin(time * 0.037 + 1.3) * 1.1,
            Math.cos(time * 0.043) * 2.0,
        ).add(this.travel);
        if (this.shake > 0) {
            cam.position.x += (Math.random() - 0.5) * this.shake;
            cam.position.y += (Math.random() - 0.5) * this.shake;
        }
        cam.up.set(0, 1, 0);
        cam.lookAt(dir.add(cam.position));
        cam.rotateZ(this._roll);
        const fov = Math.min(this.fov * this.fovMul, 100);
        if (Math.abs(cam.fov - fov) > 1e-3) {
            cam.fov = fov;
            cam.updateProjectionMatrix();
        }
    }
}
