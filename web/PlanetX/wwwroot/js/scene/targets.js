import * as THREE from "./three.js";
import { radec } from "./util.js";

import { TARGETS } from "../target-catalogue.js";
export { TARGETS, findTarget } from "../target-catalogue.js";

const BEACON_DISTANCE = 1300;
const PICK_RADIUS = 32;

export function createTargetLayer({ beacons, camera }) {
    const layer = document.createElement("div");
    layer.className = "sky-labels";
    Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "1", overflow: "hidden" });
    document.body.appendChild(layer);

    const items = TARGETS.map(t => {
        const label = document.createElement("div");
        label.className = "sky-label";
        label.textContent = t.name;
        layer.appendChild(label);
        return { target: t, position: radec(t.ra, t.dec).multiplyScalar(BEACON_DISTANCE), label, screen: new THREE.Vector2(), visible: false };
    });
    let flight = null;     // { position, target } for a non-cached destination
    let active = null;     // key or flight target currently highlighted
    let hover = null;
    const v = new THREE.Vector3();

    function refreshBeacons() {
        const list = items.map(item => ({
            position: item.position,
            size: 34,
            intensity: item === hover ? 1.6 : 1,
            highlight: active === item.target ? 1 : 0,
        }));
        if (flight) list.push({ position: flight.position, size: 40, intensity: 1.4, highlight: 1 });
        beacons.set(list);
    }
    refreshBeacons();

    function project(item) {
        v.copy(item.position).project(camera);
        item.visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        item.screen.set((v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight);
        return item.visible;
    }

    function nearest(x, y) {
        let best = null, bestDist = PICK_RADIUS;
        for (const item of items) {
            if (!project(item)) continue;
            const d = Math.hypot(item.screen.x - x, item.screen.y - y);
            if (d < bestDist) { best = item; bestDist = d; }
        }
        return best;
    }

    return {
        pick(x, y) {
            const item = nearest(x, y);
            return item ? { ...item.target } : null;
        },
        hover(x, y) {
            const item = x == null ? null : nearest(x, y);
            if (item !== hover) {
                hover = item;
                refreshBeacons();
            }
            return Boolean(item);
        },
        // Highlight the destination. Non-cached destinations get their own beacon.
        setActive(target) {
            const known = target && items.find(i => i.target.key === target.key || (Math.abs(i.target.ra - target.ra) < 0.01 && Math.abs(i.target.dec - target.dec) < 0.01));
            active = known ? known.target : null;
            flight = target && !known ? { position: radec(target.ra, target.dec).multiplyScalar(BEACON_DISTANCE), target } : null;
            refreshBeacons();
        },
        update(labelsVisible) {
            layer.style.opacity = labelsVisible ? "1" : "0";
            if (!labelsVisible) return;
            for (const item of items) {
                const on = project(item);
                item.label.style.display = on ? "block" : "none";
                if (on) {
                    item.label.style.transform = `translate(${item.screen.x + 16}px, ${item.screen.y - 8}px)`;
                    item.label.classList.toggle("is-hover", item === hover);
                }
            }
        },
    };
}
